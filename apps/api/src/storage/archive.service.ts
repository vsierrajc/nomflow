import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  archiveSettings,
  archivedObjects,
  auditLogs,
  certificateRequests,
  taxCertificates,
  vacationDocuments,
} from '../db/schema';
import {
  getArchiveSettings,
  saveArchiveSettings,
  type ArchiveSettingsInput,
  type DbColdStoreProvider,
} from './archive-settings.service';
import { ObjectStoreError, type DeletableObjectStore } from './object-store';
import { COLD_PROVIDER, RAW_HOT_STORE } from './storage.module';

const BATCH = 200;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const DAY = 86_400_000;

export interface ArchiveRunResult {
  copied: number;
  deletedLocal: number;
  failed: number;
  errors: string[];
}

export type ArchiveTestCode =
  | 'OK'
  | 'NOT_CONFIGURED'
  | 'MISMATCH'
  | 'UNAVAILABLE'
  /** El servicio reconoce las claves pero no permite operar en el bucket (faltan permisos). */
  | 'ACCESS_DENIED'
  /** Las claves no coinciden o no existen. */
  | 'INVALID_KEYS'
  | 'NO_SUCH_BUCKET'
  /** No se llegó al servicio: dirección, DNS, red o salida a internet. */
  | 'UNREACHABLE';

/** Traduce el error del servicio de objetos a un motivo que el administrador pueda corregir. */
export function explain(e: unknown): ArchiveTestCode {
  const d = e instanceof ObjectStoreError ? e.detail : undefined;
  if (!d) return 'UNAVAILABLE';
  if (d.name === 'NoSuchBucket' || d.status === 404) return 'NO_SUCH_BUCKET';
  if (
    ['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'InvalidSecurity'].includes(d.name) ||
    d.status === 401
  )
    return 'INVALID_KEYS';
  if (d.name === 'AccessDenied' || d.status === 403) return 'ACCESS_DENIED';
  if (d.status === undefined) return 'UNREACHABLE';
  return 'UNAVAILABLE';
}

export class ArchiveError extends Error {
  constructor(readonly code: 'NOT_ENABLED' | 'NOT_CONFIGURED' | 'BUSY') {
    super(code);
  }
}

/** Claves de objeto que solo están en la nube (la descarga tardará algo más). */
export async function archivedKeys(db: Db, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ k: archivedObjects.objectKey })
    .from(archivedObjects)
    .where(and(inArray(archivedObjects.objectKey, keys), eq(archivedObjects.status, 'CLOUD')));
  return new Set(rows.map((r) => r.k));
}

/** Solicitudes de vacaciones cuya constancia solo está en la nube. */
export async function archivedVacationRequestIds(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: vacationDocuments.requestId })
    .from(vacationDocuments)
    .innerJoin(archivedObjects, eq(archivedObjects.objectKey, vacationDocuments.objectKey))
    .where(and(inArray(vacationDocuments.requestId, ids), eq(archivedObjects.status, 'CLOUD')));
  return new Set(rows.map((r) => r.id));
}

@Injectable()
export class ArchiveService {
  private readonly log = new Logger('Archive');
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RAW_HOT_STORE) private readonly hot: DeletableObjectStore,
    @Inject(COLD_PROVIDER) private readonly cold: DbColdStoreProvider,
  ) {}

  async save(accountId: string, input: ArchiveSettingsInput) {
    await saveArchiveSettings(this.db, accountId, input);
    this.cold.invalidate();
    return this.overview();
  }

  async overview() {
    const settings = await getArchiveSettings(this.db);
    const cutoff = new Date(Date.now() - settings.ageDays * DAY);
    const notArchived = (key: unknown) =>
      sql`not exists (select 1 from archived_objects a where a.object_key = ${key})`;
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const [taxTotal, vacTotal, taxDue, vacDue, labTotal, labDue] = await Promise.all([
      one(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(taxCertificates)
          .where(sql`${taxCertificates.objectKey} is not null`),
      ),
      one(this.db.select({ n: sql<number>`count(*)::int` }).from(vacationDocuments)),
      one(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(taxCertificates)
          .where(
            and(
              sql`${taxCertificates.objectKey} is not null`,
              lte(taxCertificates.uploadedAt, cutoff),
              notArchived(taxCertificates.objectKey),
            ),
          ),
      ),
      one(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(vacationDocuments)
          .where(
            and(
              lte(vacationDocuments.generatedAt, cutoff),
              notArchived(vacationDocuments.objectKey),
            ),
          ),
      ),
      one(this.db.select({ n: sql<number>`count(*)::int` }).from(certificateRequests)),
      one(
        this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(certificateRequests)
          .where(
            and(
              lte(certificateRequests.createdAt, cutoff),
              notArchived(certificateRequests.objectKey),
            ),
          ),
      ),
    ]);
    const byStatus = await this.db
      .select({
        status: archivedObjects.status,
        n: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${archivedObjects.sizeBytes}), 0)::bigint`,
      })
      .from(archivedObjects)
      .groupBy(archivedObjects.status);
    const cloud = byStatus.find((r) => r.status === 'CLOUD');
    const both = byStatus.find((r) => r.status === 'BOTH');
    return {
      settings,
      stats: {
        totalObjects: taxTotal + vacTotal + labTotal,
        onlyInCloud: cloud?.n ?? 0,
        inBoth: both?.n ?? 0,
        cloudBytes: Number(cloud?.bytes ?? 0),
        eligible: taxDue + vacDue + labDue,
      },
    };
  }

  /** Prueba la conexión: escribe, lee, compara y borra un objeto de prueba. Devuelve un código que explica el fallo. */
  async test(): Promise<ArchiveTestCode> {
    this.cold.invalidate();
    const cold = await this.cold.get();
    if (!cold) return 'NOT_CONFIGURED';
    const key = `archive-probe/${randomUUID()}`;
    const data = Buffer.from(randomUUID());
    try {
      await cold.put(key, data);
      const back = await cold.get(key);
      await cold.delete(key);
      return back && back.equals(data) ? 'OK' : 'MISMATCH';
    } catch (e) {
      return explain(e);
    }
  }

  /** Copia a la nube lo que superó la edad, verifica cada copia y libera el espacio local. */
  async run(actorId: string | null): Promise<ArchiveRunResult> {
    if (this.running) throw new ArchiveError('BUSY');
    this.running = true;
    const result: ArchiveRunResult = { copied: 0, deletedLocal: 0, failed: 0, errors: [] };
    try {
      const s = await getArchiveSettings(this.db);
      if (!s.enabled) throw new ArchiveError('NOT_ENABLED');
      this.cold.invalidate();
      const cold = await this.cold.get();
      if (!cold) throw new ArchiveError('NOT_CONFIGURED');
      await this.copyDue(cold, s.ageDays, result);
      await this.releaseLocal(cold, s.graceDays, result);
      await this.finish(actorId, result);
      return result;
    } catch (e) {
      if (!(e instanceof ArchiveError)) {
        result.failed += 1;
        result.errors.push(`Error inesperado: ${(e as Error).message}`);
        await this.finish(actorId, result).catch(() => undefined);
      }
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async due(ageDays: number): Promise<{ key: string; source: string; size: number }[]> {
    const cutoff = new Date(Date.now() - ageDays * DAY);
    const notArchived = (key: unknown) =>
      sql`not exists (select 1 from archived_objects a where a.object_key = ${key})`;
    const tax = await this.db
      .select({ key: sql<string>`${taxCertificates.objectKey}`, size: taxCertificates.sizeBytes })
      .from(taxCertificates)
      .where(
        and(
          sql`${taxCertificates.objectKey} is not null`,
          lte(taxCertificates.uploadedAt, cutoff),
          notArchived(taxCertificates.objectKey),
        ),
      )
      .limit(BATCH);
    const vac = await this.db
      .select({ key: vacationDocuments.objectKey, size: vacationDocuments.sizeBytes })
      .from(vacationDocuments)
      .where(
        and(lte(vacationDocuments.generatedAt, cutoff), notArchived(vacationDocuments.objectKey)),
      )
      .limit(BATCH);
    const lab = await this.db
      .select({ key: certificateRequests.objectKey, size: certificateRequests.sizeBytes })
      .from(certificateRequests)
      .where(
        and(lte(certificateRequests.createdAt, cutoff), notArchived(certificateRequests.objectKey)),
      )
      .limit(BATCH);
    return [
      ...tax.map((r) => ({ ...r, source: 'TAX_CERT' })),
      ...vac.map((r) => ({ ...r, source: 'VACATION_DOC' })),
      ...lab.map((r) => ({ ...r, source: 'LABOR_CERT' })),
    ].slice(0, BATCH);
  }

  private async copyDue(cold: DeletableObjectStore, ageDays: number, out: ArchiveRunResult) {
    for (const c of await this.due(ageDays)) {
      try {
        const raw = await this.hot.get(c.key);
        if (raw === null) {
          // Ya no está en local: si está en la nube se registra; si no, es un hueco que hay que ver.
          const there = await cold.get(c.key);
          if (there) await this.record(c, there, 'CLOUD', new Date());
          else throw new Error('no existe ni en local ni en la nube');
          continue;
        }
        await cold.put(c.key, raw);
        const back = await cold.get(c.key);
        if (!back || sha(back) !== sha(raw))
          throw new Error('la copia no coincide con el original');
        await this.record(c, raw, 'BOTH', null);
        out.copied += 1;
      } catch (e) {
        out.failed += 1;
        out.errors.push(
          `${c.key}: ${e instanceof ObjectStoreError ? explain(e) : (e as Error).message}`,
        );
      }
    }
  }

  private async record(
    c: { key: string; source: string },
    bytes: Buffer,
    status: 'BOTH' | 'CLOUD',
    localDeletedAt: Date | null,
  ) {
    const values = {
      objectKey: c.key,
      source: c.source,
      status,
      sha256: sha(bytes),
      sizeBytes: bytes.length,
      // Hora de la aplicación (no la de PostgreSQL): la gracia se compara con este mismo reloj.
      archivedAt: new Date(),
      localDeletedAt,
    };
    await this.db
      .insert(archivedObjects)
      .values(values)
      .onConflictDoUpdate({ target: archivedObjects.objectKey, set: values });
  }

  /** Borra de local lo que ya pasó el período de gracia, tras comprobar de nuevo la copia en la nube. */
  private async releaseLocal(cold: DeletableObjectStore, graceDays: number, out: ArchiveRunResult) {
    const before = new Date(Date.now() - graceDays * DAY);
    const rows = await this.db
      .select()
      .from(archivedObjects)
      .where(and(eq(archivedObjects.status, 'BOTH'), lte(archivedObjects.archivedAt, before)))
      .limit(BATCH);
    for (const r of rows) {
      try {
        const back = await cold.get(r.objectKey);
        if (!back || sha(back) !== r.sha256)
          throw new Error('la copia en la nube no se pudo verificar; se conserva en local');
        await this.hot.delete(r.objectKey);
        await this.db
          .update(archivedObjects)
          .set({ status: 'CLOUD', localDeletedAt: new Date() })
          .where(eq(archivedObjects.objectKey, r.objectKey));
        out.deletedLocal += 1;
      } catch (e) {
        out.failed += 1;
        out.errors.push(
          `${r.objectKey}: ${e instanceof ObjectStoreError ? explain(e) : (e as Error).message}`,
        );
      }
    }
  }

  private async finish(actorId: string | null, r: ArchiveRunResult) {
    const summary = `Copiados ${r.copied}, liberados de local ${r.deletedLocal}, fallos ${r.failed}.`;
    await this.db
      .update(archiveSettings)
      .set({
        lastRunAt: new Date(),
        lastRunStatus: r.failed > 0 ? 'ERROR' : 'OK',
        lastRunSummary: (r.errors[0] ? `${summary} Primer error: ${r.errors[0]}` : summary).slice(
          0,
          500,
        ),
      })
      .where(eq(archiveSettings.id, 1));
    await this.db.insert(auditLogs).values({
      actorAccountId: actorId,
      action: 'ARCHIVE_RUN',
      resource: 'archived_objects',
      result: r.failed > 0 ? 'PARTIAL' : 'SUCCESS',
      context: { copied: r.copied, deletedLocal: r.deletedLocal, failed: r.failed },
    });
    this.log.log(summary);
  }
}
