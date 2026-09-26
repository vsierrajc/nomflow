import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat, truncate } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { accounts, auditLogs, logArchives, logSettings } from '../db/schema';
import { HTTP_ACTION } from '../audit/request-audit.service';
import { EncryptedObjectStore, objectEncryptionSecret } from '../storage/encrypted-object-store';
import type { DbColdStoreProvider } from '../storage/archive-settings.service';
import { COLD_PROVIDER } from '../storage/storage.module';

export type AuditKind = 'HTTP' | 'EVENTOS' | 'TODO';
export type LogErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'COLD_NOT_CONFIGURED'
  | 'NO_KEY'
  | 'ARCHIVE_FAILED'
  | 'TOO_LARGE'
  | 'CONFIRM_REQUIRED';

export class LogError extends Error {
  constructor(
    readonly code: LogErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/** Los registros de las propias operaciones de mantenimiento nunca se borran: son la huella de la depuración. */
const KEEP_ACTIONS = [
  'AUDIT_PURGE',
  'LOG_ARCHIVE',
  'LOG_EXPORT',
  'LOG_FILE_TRUNCATE',
  'LOG_SETTINGS_UPDATE',
];
const DAY = 86_400_000;
const PAGE = 5000;
/** Por encima de esto un mes se divide por días al archivar (memoria acotada). */
const CHUNK_ROWS = 250_000;
const EXPORT_MAX_ROWS = 1_000_000;
const FILE_MAX_BYTES = 100 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

export interface LogSettingsValues {
  retentionDays: number;
  httpRetentionDays: number;
  archiveBeforePurge: boolean;
  autoEnabled: boolean;
}
export const DEFAULT_LOG_SETTINGS: LogSettingsValues = {
  retentionDays: 365,
  httpRetentionDays: 90,
  archiveBeforePurge: true,
  autoEnabled: false,
};

export function validLogSettings(s: LogSettingsValues): boolean {
  const int = (v: number, a: number, b: number) => Number.isInteger(v) && v >= a && v <= b;
  return int(s.retentionDays, 30, 3650) && int(s.httpRetentionDays, 7, 3650);
}

/** Zona horaria de la organización: un día «AAAA-MM-DD» empieza a las 00:00 de Bogotá (UTC-5). */
export const startOfDay = (d: string) => new Date(`${d}T00:00:00-05:00`);
export const endOfDay = (d: string) => new Date(`${d}T23:59:59.999-05:00`);

const kindFilter = (kind: AuditKind): SQL | undefined =>
  kind === 'HTTP'
    ? eq(auditLogs.action, HTTP_ACTION)
    : kind === 'EVENTOS'
      ? sql`${auditLogs.action} <> ${HTTP_ACTION}`
      : undefined;

/** Archivos de registro de la aplicación que se pueden gestionar: solo los de LOG_FILES (nombre=ruta). */
export function configuredFiles(
  env: NodeJS.ProcessEnv = process.env,
): { name: string; path: string }[] {
  return (env.LOG_FILES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => {
      const i = p.indexOf('=');
      const name = p.slice(0, i).trim();
      const path = p.slice(i + 1).trim();
      return i > 0 && /^[A-Za-z0-9_-]{1,30}$/.test(name) && path ? [{ name, path }] : [];
    });
}

const csvCell = (v: unknown) => {
  const s =
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

interface ExportRow {
  id: string;
  at: Date;
  action: string;
  resource: string;
  resourceId: string | null;
  result: string;
  context: unknown;
  actor: string | null;
}
interface ArchiveRow {
  id: string;
  at: Date;
  actorAccountId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: string;
  context: unknown;
}

export interface AuditRange {
  from?: string | undefined;
  to?: string | undefined;
  kind: AuditKind;
}

@Injectable()
export class LogsService {
  private readonly log = new Logger('Logs');
  private busy = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(COLD_PROVIDER) private readonly cold: DbColdStoreProvider,
  ) {}

  // ---------- política ----------
  async getSettings(): Promise<
    LogSettingsValues & {
      lastRunAt: Date | null;
      lastRunStatus: string | null;
      lastRunSummary: string | null;
    }
  > {
    const [s] = await this.db.select().from(logSettings).where(eq(logSettings.id, 1));
    return {
      ...(s
        ? {
            retentionDays: s.retentionDays,
            httpRetentionDays: s.httpRetentionDays,
            archiveBeforePurge: s.archiveBeforePurge,
            autoEnabled: s.autoEnabled,
          }
        : DEFAULT_LOG_SETTINGS),
      lastRunAt: s?.lastRunAt ?? null,
      lastRunStatus: s?.lastRunStatus ?? null,
      lastRunSummary: s?.lastRunSummary ?? null,
    };
  }

  async saveSettings(actor: string, input: LogSettingsValues) {
    if (!validLogSettings(input)) throw new LogError('INVALID');
    await this.db.transaction(async (tx) => {
      await tx
        .insert(logSettings)
        .values({ id: 1, ...input, updatedBy: actor })
        .onConflictDoUpdate({
          target: logSettings.id,
          set: { ...input, updatedBy: actor, updatedAt: new Date() },
        });
      await tx.insert(auditLogs).values({
        actorAccountId: actor,
        action: 'LOG_SETTINGS_UPDATE',
        resource: 'log_settings',
        resourceId: '1',
        result: 'SUCCESS',
        context: input,
      });
    });
    return this.getSettings();
  }

  // ---------- resumen ----------
  async summary() {
    const [tot] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        http: sql<number>`count(*) filter (where ${auditLogs.action} = ${HTTP_ACTION})::int`,
        oldest: sql<Date | null>`min(${auditLogs.at})`,
        newest: sql<Date | null>`max(${auditLogs.at})`,
      })
      .from(auditLogs);
    const months = await this.db
      .select({
        month: sql<string>`to_char(${auditLogs.at} at time zone 'America/Bogota', 'YYYY-MM')`,
        n: sql<number>`count(*)::int`,
      })
      .from(auditLogs)
      .groupBy(sql`1`)
      .orderBy(desc(sql`1`))
      .limit(12);
    const [size] = await this.db
      .execute<{ bytes: string }>(sql`select pg_total_relation_size('audit_logs')::text as bytes`)
      .then((r) => r.rows);
    const files = await this.filesInfo();
    const archives = await this.listArchives(20);
    return {
      audit: {
        total: tot?.total ?? 0,
        http: tot?.http ?? 0,
        events: (tot?.total ?? 0) - (tot?.http ?? 0),
        oldest: tot?.oldest ?? null,
        newest: tot?.newest ?? null,
        tableBytes: Number(size?.bytes ?? 0),
        months: months.reverse(),
      },
      files,
      settings: await this.getSettings(),
      archives,
      coldConfigured: (await this.cold.get()) !== null,
    };
  }

  // ---------- exportar ----------
  private whereOf(r: AuditRange, extra: SQL[] = []) {
    const f: SQL[] = [...extra];
    const k = kindFilter(r.kind);
    if (k) f.push(k);
    if (r.from) f.push(gte(auditLogs.at, startOfDay(r.from)));
    if (r.to) f.push(lte(auditLogs.at, endOfDay(r.to)));
    return f.length ? and(...f) : undefined;
  }

  /** Exporta por trozos (sin cargar todo en memoria): CSV o JSON Lines. */
  async *exportChunks(r: AuditRange, format: 'csv' | 'jsonl'): AsyncGenerator<string> {
    const where = this.whereOf(r);
    if (format === 'csv') yield 'fecha,accion,recurso,id_recurso,resultado,usuario,contexto\n';
    let cursor: { at: Date; id: string } | null = null;
    let sent = 0;
    while (sent < EXPORT_MAX_ROWS) {
      const page: ExportRow[] = await this.db
        .select({
          id: auditLogs.id,
          at: auditLogs.at,
          action: auditLogs.action,
          resource: auditLogs.resource,
          resourceId: auditLogs.resourceId,
          result: auditLogs.result,
          context: auditLogs.context,
          actor: accounts.email,
        })
        .from(auditLogs)
        .leftJoin(accounts, eq(accounts.id, auditLogs.actorAccountId))
        .where(
          cursor
            ? and(
                where,
                sql`(${auditLogs.at}, ${auditLogs.id}) > (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
              )
            : where,
        )
        .orderBy(asc(auditLogs.at), asc(auditLogs.id))
        .limit(PAGE);
      if (page.length === 0) break;
      let out = '';
      for (const row of page) {
        out +=
          format === 'csv'
            ? [
                row.at.toISOString(),
                row.action,
                row.resource,
                row.resourceId,
                row.result,
                row.actor,
                row.context,
              ]
                .map(csvCell)
                .join(',') + '\n'
            : JSON.stringify({
                at: row.at.toISOString(),
                action: row.action,
                resource: row.resource,
                resourceId: row.resourceId,
                result: row.result,
                actor: row.actor,
                context: row.context,
              }) + '\n';
      }
      sent += page.length;
      const last = page[page.length - 1];
      if (last) cursor = { at: last.at, id: last.id };
      yield out;
      if (page.length < PAGE) break;
    }
  }

  async countRange(r: AuditRange): Promise<number> {
    const [c] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(this.whereOf(r));
    return c?.n ?? 0;
  }

  async recordEvent(actor: string | null, action: string, result: string, context: object) {
    await this.db
      .insert(auditLogs)
      .values({ actorAccountId: actor, action, resource: 'logs', result, context });
  }

  // ---------- nube ----------
  private async coldStore(): Promise<EncryptedObjectStore> {
    const cold = await this.cold.get();
    if (!cold) throw new LogError('COLD_NOT_CONFIGURED');
    const secret = objectEncryptionSecret();
    if (secret.length < 32) throw new LogError('NO_KEY');
    return new EncryptedObjectStore(cold, secret);
  }

  /** Sube el contenido comprimido y cifrado, lo relee y comprueba el sha256 antes de dar la copia por buena. */
  private async putVerified(key: string, gz: Buffer): Promise<void> {
    const store = await this.coldStore();
    try {
      await store.put(key, gz, 'application/gzip');
      const back = await store.get(key);
      if (
        !back ||
        createHash('sha256').update(back).digest('hex') !==
          createHash('sha256').update(gz).digest('hex')
      )
        throw new LogError('ARCHIVE_FAILED', 'la copia no coincide con el original');
    } catch (e) {
      if (e instanceof LogError) throw e;
      throw new LogError('ARCHIVE_FAILED', (e as Error).message);
    }
  }

  /** Meses (en hora de Bogotá) que cubre el intervalo [from, to). */
  private monthChunks(from: Date, to: Date): { a: Date; b: Date }[] {
    const out: { a: Date; b: Date }[] = [];
    let a = from;
    while (a < to) {
      const local = new Date(a.getTime() - 5 * 3_600_000);
      const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1, 5, 0, 0));
      const b = next < to ? next : to;
      out.push({ a, b });
      a = b;
    }
    return out;
  }

  /**
   * Archiva [a, b) de la auditoría: JSONL comprimido y cifrado en el histórico. Si `purge`, borra de la
   * base exactamente las filas copiadas, y solo después de verificar la copia.
   */
  private async archiveInterval(
    actor: string | null,
    kind: AuditKind,
    a: Date,
    b: Date,
    purge: boolean,
  ): Promise<{ archived: number; deleted: number; archives: number }> {
    const base = and(
      gte(auditLogs.at, a),
      lt(auditLogs.at, b),
      notInArray(auditLogs.action, KEEP_ACTIONS),
      kindFilter(kind),
    );
    const [c] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(base);
    const n = c?.n ?? 0;
    if (n === 0) return { archived: 0, deleted: 0, archives: 0 };
    if (n > CHUNK_ROWS && b.getTime() - a.getTime() > DAY) {
      // demasiado grande: se parte en dos mitades
      const mid = new Date(a.getTime() + Math.floor((b.getTime() - a.getTime()) / 2));
      const l = await this.archiveInterval(actor, kind, a, mid, purge);
      const r = await this.archiveInterval(actor, kind, mid, b, purge);
      return {
        archived: l.archived + r.archived,
        deleted: l.deleted + r.deleted,
        archives: l.archives + r.archives,
      };
    }
    const lines: string[] = [];
    const ids: string[] = [];
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const page: ArchiveRow[] = await this.db
        .select({
          id: auditLogs.id,
          at: auditLogs.at,
          actorAccountId: auditLogs.actorAccountId,
          action: auditLogs.action,
          resource: auditLogs.resource,
          resourceId: auditLogs.resourceId,
          result: auditLogs.result,
          context: auditLogs.context,
        })
        .from(auditLogs)
        .where(
          cursor
            ? and(
                base,
                sql`(${auditLogs.at}, ${auditLogs.id}) > (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
              )
            : base,
        )
        .orderBy(asc(auditLogs.at), asc(auditLogs.id))
        .limit(PAGE);
      if (page.length === 0) break;
      for (const r of page) {
        ids.push(r.id);
        lines.push(JSON.stringify({ ...r, at: r.at.toISOString() }));
      }
      const last = page[page.length - 1];
      if (last) cursor = { at: last.at, id: last.id };
      if (page.length < PAGE) break;
    }
    const gz = gzipSync(Buffer.from(lines.join('\n') + '\n'));
    const id = randomUUID();
    const yyyy = String(a.getUTCFullYear());
    const key = `log-archives/auditoria/${yyyy}/${id}.jsonl.gz`;
    await this.putVerified(key, gz);
    let deleted = 0;
    if (purge) {
      for (let i = 0; i < ids.length; i += PAGE) {
        const r = await this.db.execute(
          sql`delete from audit_logs where id in (${sql.join(
            ids.slice(i, i + PAGE).map((x) => sql`${x}::uuid`),
            sql`, `,
          )})`,
        );
        deleted += r.rowCount ?? 0;
      }
    }
    await this.db.insert(logArchives).values({
      id,
      source: 'AUDITORIA',
      kind,
      periodFrom: a,
      periodTo: b,
      rowCount: ids.length,
      sizeBytes: gz.length,
      sha256: createHash('sha256').update(gz).digest('hex'),
      objectKey: key,
      purgedCount: deleted,
      createdBy: actor,
    });
    return { archived: ids.length, deleted, archives: 1 };
  }

  private async range(
    kind: AuditKind,
    from: string | undefined,
    to: string | undefined,
  ): Promise<{ a: Date; b: Date }> {
    const [o] = await this.db
      .select({ oldest: sql<Date | null>`min(${auditLogs.at})` })
      .from(auditLogs)
      .where(kindFilter(kind));
    const a = from ? startOfDay(from) : o?.oldest ? new Date(o.oldest) : new Date();
    const b = to ? new Date(endOfDay(to).getTime() + 1) : new Date();
    if (a >= b) throw new LogError('INVALID', 'el rango está vacío');
    return { a, b };
  }

  /** Copia a la nube un rango de la auditoría sin borrar nada. */
  async archiveAudit(actor: string | null, r: AuditRange) {
    if (this.busy) throw new LogError('INVALID', 'hay otra operación en curso');
    this.busy = true;
    try {
      const { a, b } = await this.range(r.kind, r.from, r.to);
      let archived = 0;
      let archives = 0;
      for (const c of this.monthChunks(a, b)) {
        const res = await this.archiveInterval(actor, r.kind, c.a, c.b, false);
        archived += res.archived;
        archives += res.archives;
      }
      await this.recordEvent(actor, 'LOG_ARCHIVE', 'SUCCESS', {
        source: 'AUDITORIA',
        kind: r.kind,
        from: a.toISOString(),
        to: b.toISOString(),
        archived,
        archives,
      });
      return { archived, archives };
    } finally {
      this.busy = false;
    }
  }

  // ---------- depurar ----------
  /**
   * Borra la auditoría anterior a `before` (AAAA-MM-DD, exclusivo). Con `archive`, primero la copia al histórico y solo
   * borra lo copiado y verificado. Deja una fila `AUDIT_PURGE` con lo que se hizo.
   */
  async purgeAudit(
    actor: string | null,
    o: { before: string; kind: AuditKind; archive: boolean; reason: string },
  ) {
    if (this.busy) throw new LogError('INVALID', 'hay otra operación en curso');
    this.busy = true;
    try {
      const limit = startOfDay(o.before);
      if (Number.isNaN(limit.getTime()) || limit.getTime() > Date.now() + DAY)
        throw new LogError('INVALID', 'fecha inválida');
      let archived = 0;
      let deleted = 0;
      if (o.archive) {
        const { a } = await this.range(o.kind, undefined, undefined);
        for (const c of this.monthChunks(a, limit)) {
          const res = await this.archiveInterval(actor, o.kind, c.a, c.b, true);
          archived += res.archived;
          deleted += res.deleted;
        }
      } else {
        const where = and(
          lt(auditLogs.at, limit),
          notInArray(auditLogs.action, KEEP_ACTIONS),
          kindFilter(o.kind),
        );
        const r = await this.db.execute(
          sql`delete from audit_logs where id in (select id from audit_logs where ${where} )`,
        );
        deleted = r.rowCount ?? 0;
      }
      await this.recordEvent(actor, 'AUDIT_PURGE', 'SUCCESS', {
        kind: o.kind,
        before: limit.toISOString(),
        deleted,
        archived,
        withArchive: o.archive,
        reason: o.reason.slice(0, 300),
      });
      return { deleted, archived };
    } finally {
      this.busy = false;
    }
  }

  // ---------- archivos de la aplicación ----------
  private fileOf(name: string) {
    const f = configuredFiles().find((x) => x.name === name);
    if (!f) throw new LogError('NOT_FOUND');
    return f;
  }

  async filesInfo() {
    const out: { name: string; size: number; modified: string | null }[] = [];
    for (const f of configuredFiles()) {
      const s = await stat(f.path).catch(() => null);
      out.push({ name: f.name, size: s?.size ?? 0, modified: s ? s.mtime.toISOString() : null });
    }
    return out;
  }

  /** Últimas líneas del archivo (lee solo el final), con filtro opcional por texto. */
  async tail(name: string, lines: number, q?: string) {
    const f = this.fileOf(name);
    const s = await stat(f.path).catch(() => null);
    if (!s) return { lines: [] as string[], size: 0 };
    const len = Math.min(s.size, TAIL_BYTES);
    const fh = await open(f.path, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, s.size - len);
      // quita los ceros que deja un archivo vaciado mientras el proceso seguía escribiendo
      let all = Array.from(buf.toString('utf8'), (c) => (c === '\u0000' ? '' : c))
        .join('')
        .split('\n');
      if (s.size > len) all = all.slice(1); // primera línea posiblemente cortada
      const needle = q?.trim().toLowerCase();
      const filtered = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all;
      return {
        lines: filtered.filter((l, i, a) => l !== '' || i < a.length - 1).slice(-lines),
        size: s.size,
      };
    } finally {
      await fh.close();
    }
  }

  fileStream(name: string) {
    return createReadStream(this.fileOf(name).path);
  }

  async archiveFile(actor: string | null, name: string) {
    const f = this.fileOf(name);
    const s = await stat(f.path).catch(() => null);
    if (!s || s.size === 0) throw new LogError('INVALID', 'el archivo está vacío');
    if (s.size > FILE_MAX_BYTES) throw new LogError('TOO_LARGE');
    const gz = gzipSync(await readFile(f.path));
    const id = randomUUID();
    const key = `log-archives/${name}/${new Date().getUTCFullYear()}/${id}.log.gz`;
    await this.putVerified(key, gz);
    await this.db.insert(logArchives).values({
      id,
      source: name.toUpperCase(),
      kind: null,
      periodFrom: null,
      periodTo: new Date(),
      rowCount: 0,
      sizeBytes: gz.length,
      sha256: createHash('sha256').update(gz).digest('hex'),
      objectKey: key,
      purgedCount: 0,
      createdBy: actor,
    });
    await this.recordEvent(actor, 'LOG_ARCHIVE', 'SUCCESS', { source: name, bytes: s.size });
    return { id, bytes: s.size };
  }

  /** Vacía el archivo (el proceso sigue escribiendo al final: se inició con la salida en modo añadir). */
  async truncateFile(
    actor: string | null,
    name: string,
    o: { archiveFirst: boolean; reason: string },
  ) {
    const f = this.fileOf(name);
    const s = await stat(f.path).catch(() => null);
    if (!s) throw new LogError('NOT_FOUND');
    if (o.archiveFirst && s.size > 0) await this.archiveFile(actor, name);
    await truncate(f.path, 0);
    await this.recordEvent(actor, 'LOG_FILE_TRUNCATE', 'SUCCESS', {
      file: name,
      bytes: s.size,
      archivedFirst: o.archiveFirst,
      reason: o.reason.slice(0, 300),
    });
    return { cleared: s.size };
  }

  // ---------- copias en la nube ----------
  async listArchives(limit = 50) {
    return this.db.select().from(logArchives).orderBy(desc(logArchives.createdAt)).limit(limit);
  }

  /** Descarga una copia del histórico: se descifra y se entrega el .gz original. */
  async downloadArchive(id: string): Promise<{ data: Buffer; fileName: string }> {
    const [a] = await this.db.select().from(logArchives).where(eq(logArchives.id, id));
    if (!a) throw new LogError('NOT_FOUND');
    const store = await this.coldStore();
    const gz = await store.get(a.objectKey);
    if (!gz || createHash('sha256').update(gz).digest('hex') !== a.sha256)
      throw new LogError('ARCHIVE_FAILED', 'la copia no está o no coincide');
    const ext = a.source === 'AUDITORIA' ? 'jsonl.gz' : 'log.gz';
    return {
      data: gz,
      fileName: `${a.source.toLowerCase()}-${a.createdAt.toISOString().slice(0, 10)}-${a.id.slice(0, 8)}.${ext}`,
    };
  }

  /** Cuántas filas de auditoría se leen de una copia (para comprobarla sin descargarla). */
  static countLines(gz: Buffer): number {
    return gunzipSync(gz).toString('utf8').split('\n').filter(Boolean).length;
  }

  // ---------- mantenimiento según la política ----------
  async runMaintenance(actor: string | null): Promise<{ purged: number; archived: number }> {
    const s = await this.getSettings();
    const now = Date.now();
    const cut = (days: number) => new Date(now - days * DAY);
    const day = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
    let purged = 0;
    let archived = 0;
    for (const [kind, days] of [
      ['HTTP', s.httpRetentionDays],
      ['EVENTOS', s.retentionDays],
    ] as const) {
      const r = await this.purgeAudit(actor, {
        before: day(cut(days)),
        kind,
        archive: s.archiveBeforePurge,
        reason: 'Mantenimiento según la política de retención',
      });
      purged += r.deleted;
      archived += r.archived;
    }
    return { purged, archived };
  }

  async recordRun(status: 'OK' | 'ERROR', summary: string) {
    await this.db
      .insert(logSettings)
      .values({
        id: 1,
        lastRunAt: new Date(),
        lastRunStatus: status,
        lastRunSummary: summary.slice(0, 500),
      })
      .onConflictDoUpdate({
        target: logSettings.id,
        set: {
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunSummary: summary.slice(0, 500),
        },
      });
  }

  logger() {
    return this.log;
  }
}
