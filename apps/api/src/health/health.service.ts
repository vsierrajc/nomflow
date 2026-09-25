import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { ADMIN_ROLES } from '../auth/roles';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { accounts, auditLogs, healthAlerts, healthSettings, roleAssignments } from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { getSettings as getMailSettings, isEmail } from '../mail/mail-settings.service';
import { OBJECT_STORE, ObjectStoreError, type ObjectStore } from '../storage/object-store';

export type Level = 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';

export interface CheckResult {
  key: string;
  label: string;
  level: Level;
  message: string;
}

export interface Snapshot {
  checkedAt: string;
  overall: Level;
  checks: CheckResult[];
}

export interface HealthSettingsValues {
  storageWarnFreePct: number;
  storageCritFreePct: number;
  dbWarnMs: number;
  dbCritMs: number;
  objectErrorsWarn: number;
  objectErrorsCrit: number;
  errorWindowMin: number;
  checkIntervalMin: number;
  renotifyMin: number;
  extraRecipients: string;
}

export const DEFAULT_SETTINGS: HealthSettingsValues = {
  storageWarnFreePct: 20,
  storageCritFreePct: 10,
  dbWarnMs: 500,
  dbCritMs: 2000,
  objectErrorsWarn: 3,
  objectErrorsCrit: 10,
  errorWindowMin: 60,
  checkIntervalMin: 5,
  renotifyMin: 360,
  extraRecipients: '',
};

export class HealthSettingsError extends Error {
  constructor(readonly code: 'INVALID_SETTINGS') {
    super(code);
  }
}

/** Mide el espacio libre del almacén de objetos: un elemento por nodo. */
export const SPACE_PROBE = Symbol('SPACE_PROBE');
export type SpaceProbe = () => Promise<{ available: number; total: number }[]>;

/** Espacio según la API de administración de Garage (GARAGE_ADMIN_ENDPOINT + GARAGE_ADMIN_TOKEN). */
export const garageSpaceProbe: SpaceProbe = async () => {
  const token = process.env.GARAGE_ADMIN_TOKEN;
  if (!token) throw new Error('NO_ADMIN_TOKEN');
  const base = process.env.GARAGE_ADMIN_ENDPOINT || 'http://localhost:3903';
  const res = await fetch(`${base}/v2/GetClusterStatus`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  const body = (await res.json()) as {
    nodes?: { isUp?: boolean; dataPartition?: { available: number; total: number } | null }[];
  };
  const parts = (body.nodes ?? []).flatMap((n) => (n.dataPartition ? [n.dataPartition] : []));
  if (parts.length === 0) throw new Error('NO_DATA');
  return parts;
};

const worst = (levels: Level[]): Level =>
  levels.includes('CRIT')
    ? 'CRIT'
    : levels.includes('WARN')
      ? 'WARN'
      : levels.includes('OK')
        ? 'OK'
        : 'UNKNOWN';

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;
const ERROR_RESULTS = [
  'UNAVAILABLE',
  'INTEGRITY',
  'ERROR',
  'HASH_MISMATCH',
  'OBJECT_MISSING',
  'NOT_CONFIGURED',
];
const DOWNLOAD_ACTIONS = ['TAX_CERT_DOWNLOAD', 'VACATION_DOCUMENT_DOWNLOAD'];

export function validateSettings(i: HealthSettingsValues): string[] {
  const bad: string[] = [];
  const int = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
  if (
    !int(i.storageCritFreePct, 1, 90) ||
    !int(i.storageWarnFreePct, 2, 95) ||
    i.storageCritFreePct >= i.storageWarnFreePct
  )
    bad.push('storage');
  if (!int(i.dbWarnMs, 10, 60000) || !int(i.dbCritMs, 20, 120000) || i.dbWarnMs >= i.dbCritMs)
    bad.push('db');
  if (
    !int(i.objectErrorsWarn, 1, 10000) ||
    !int(i.objectErrorsCrit, 1, 10000) ||
    i.objectErrorsWarn > i.objectErrorsCrit
  )
    bad.push('errors');
  if (!int(i.errorWindowMin, 5, 1440)) bad.push('window');
  if (!int(i.checkIntervalMin, 1, 60)) bad.push('interval');
  if (!int(i.renotifyMin, 15, 1440)) bad.push('renotify');
  const extras = parseRecipients(i.extraRecipients);
  if (extras.length > 20 || extras.some((e) => !isEmail(e))) bad.push('recipients');
  return bad;
}

export const parseRecipients = (v: string): string[] => [
  ...new Set(
    v
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
];

@Injectable()
export class HealthService {
  private readonly log = new Logger('Health');
  private cache: Snapshot | null = null;
  private running: Promise<Snapshot> | null = null;
  /** Respaldo si la base de datos está caída y no se puede guardar el estado de la alerta. */
  private memNotified = new Map<string, { level: Level; at: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SPACE_PROBE) private readonly probe: SpaceProbe,
  ) {}

  async getSettings(): Promise<HealthSettingsValues> {
    const [s] = await this.db.select().from(healthSettings).where(eq(healthSettings.id, 1));
    if (!s) return { ...DEFAULT_SETTINGS };
    return {
      storageWarnFreePct: s.storageWarnFreePct,
      storageCritFreePct: s.storageCritFreePct,
      dbWarnMs: s.dbWarnMs,
      dbCritMs: s.dbCritMs,
      objectErrorsWarn: s.objectErrorsWarn,
      objectErrorsCrit: s.objectErrorsCrit,
      errorWindowMin: s.errorWindowMin,
      checkIntervalMin: s.checkIntervalMin,
      renotifyMin: s.renotifyMin,
      extraRecipients: s.extraRecipients,
    };
  }

  async saveSettings(
    accountId: string,
    input: HealthSettingsValues,
  ): Promise<HealthSettingsValues> {
    if (validateSettings(input).length > 0) throw new HealthSettingsError('INVALID_SETTINGS');
    const values = { ...input, extraRecipients: parseRecipients(input.extraRecipients).join(', ') };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(healthSettings)
        .values({ id: 1, ...values, updatedBy: accountId })
        .onConflictDoUpdate({
          target: healthSettings.id,
          set: { ...values, updatedBy: accountId, updatedAt: new Date() },
        });
      await tx.insert(auditLogs).values({
        actorAccountId: accountId,
        action: 'HEALTH_SETTINGS_UPDATE',
        resource: 'health_settings',
        resourceId: '1',
        result: 'SUCCESS',
        context: values,
      });
    });
    return this.getSettings();
  }

  /** Última medición si tiene menos de `maxAgeMs`; si no, mide ahora. */
  async latest(maxAgeMs = 60_000): Promise<Snapshot> {
    if (this.cache && Date.now() - Date.parse(this.cache.checkedAt) < maxAgeMs) return this.cache;
    return this.check();
  }

  /** Mide, actualiza las alertas y avisa por correo. Las mediciones simultáneas se juntan en una. */
  check(): Promise<Snapshot> {
    this.running ??= this.runOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async runOnce(): Promise<Snapshot> {
    const settings = await this.getSettings().catch(() => ({ ...DEFAULT_SETTINGS }));
    const checks = await this.measure(settings);
    const snap: Snapshot = {
      checkedAt: new Date().toISOString(),
      overall: worst(checks.map((c) => c.level)),
      checks,
    };
    this.cache = snap;
    try {
      await this.reconcile(checks, settings);
    } catch (e) {
      this.log.error(`No se pudieron actualizar las alertas: ${(e as Error).message}`);
      await this.notifyFromMemory(checks, settings);
    }
    return snap;
  }

  private async measure(s: HealthSettingsValues): Promise<CheckResult[]> {
    return Promise.all([
      this.checkDatabase(s),
      this.checkStorage(),
      this.checkSpace(s),
      this.checkErrors(s),
      this.checkMail(),
    ]);
  }

  private async checkDatabase(s: HealthSettingsValues): Promise<CheckResult> {
    const base = { key: 'database', label: 'Base de datos' };
    const t0 = Date.now();
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      return { ...base, level: 'CRIT', message: 'PostgreSQL no responde.' };
    }
    const ms = Date.now() - t0;
    const level: Level = ms >= s.dbCritMs ? 'CRIT' : ms >= s.dbWarnMs ? 'WARN' : 'OK';
    return {
      ...base,
      level,
      message: `Responde en ${ms} ms (aviso ${s.dbWarnMs} ms, crítico ${s.dbCritMs} ms).`,
    };
  }

  private async checkStorage(): Promise<CheckResult> {
    const base = { key: 'storage_reachable', label: 'Almacén de objetos (Garage)' };
    try {
      await this.store.get('health/probe');
      return { ...base, level: 'OK', message: 'Responde y el bucket está disponible.' };
    } catch (e) {
      if (e instanceof ObjectStoreError && e.code === 'NOT_CONFIGURED')
        return {
          ...base,
          level: 'WARN',
          message:
            'Sin configurar (faltan S3_* u OBJECT_ENCRYPTION_KEY): certificados y constancias no se pueden guardar ni descargar.',
        };
      return {
        ...base,
        level: 'CRIT',
        message: 'Garage no responde: certificados y constancias no están disponibles.',
      };
    }
  }

  private async checkSpace(s: HealthSettingsValues): Promise<CheckResult> {
    const base = { key: 'storage_space', label: 'Espacio libre para objetos' };
    let parts: { available: number; total: number }[];
    try {
      parts = await this.probe();
    } catch (e) {
      const why =
        (e as Error).message === 'NO_ADMIN_TOKEN'
          ? 'falta GARAGE_ADMIN_TOKEN'
          : 'la administración de Garage no respondió';
      return { ...base, level: 'WARN', message: `No se pudo medir el espacio: ${why}.` };
    }
    const nodes = parts.map((p) => ({ ...p, pct: (p.available / p.total) * 100 }));
    const low = nodes.reduce((a, b) => (b.pct < a.pct ? b : a));
    const pct = Math.round(low.pct * 10) / 10;
    const level: Level =
      low.pct <= s.storageCritFreePct ? 'CRIT' : low.pct <= s.storageWarnFreePct ? 'WARN' : 'OK';
    return {
      ...base,
      level,
      message: `${pct} % libre (${gib(low.available)} de ${gib(low.total)}). Aviso ≤ ${s.storageWarnFreePct} %, crítico ≤ ${s.storageCritFreePct} %.`,
    };
  }

  private async checkErrors(s: HealthSettingsValues): Promise<CheckResult> {
    const base = { key: 'object_errors', label: 'Errores al descargar documentos' };
    try {
      const since = new Date(Date.now() - s.errorWindowMin * 60_000);
      const [row] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(
          and(
            inArray(auditLogs.action, DOWNLOAD_ACTIONS),
            inArray(auditLogs.result, ERROR_RESULTS),
            gte(auditLogs.at, since),
          ),
        );
      const n = row?.n ?? 0;
      const level: Level =
        n >= s.objectErrorsCrit ? 'CRIT' : n >= s.objectErrorsWarn ? 'WARN' : 'OK';
      return {
        ...base,
        level,
        message: `${n} en los últimos ${s.errorWindowMin} min (aviso ≥ ${s.objectErrorsWarn}, crítico ≥ ${s.objectErrorsCrit}).`,
      };
    } catch {
      return { ...base, level: 'UNKNOWN', message: 'No se pudo consultar la auditoría.' };
    }
  }

  private async checkMail(): Promise<CheckResult> {
    const base = { key: 'mail', label: 'Correo saliente' };
    try {
      const m = await getMailSettings(this.db);
      if (!m.configured)
        return {
          ...base,
          level: 'WARN',
          message: 'Sin configurar: las alertas y los códigos no se pueden enviar.',
        };
      if (m.lastTestStatus && m.lastTestStatus !== 'OK')
        return {
          ...base,
          level: 'WARN',
          message: `La última prueba de envío falló (${m.lastTestStatus}).`,
        };
      return { ...base, level: 'OK', message: `Configurado (${m.host}:${m.port}).` };
    } catch {
      return { ...base, level: 'UNKNOWN', message: 'No se pudo leer la configuración.' };
    }
  }

  /** Abre, actualiza y resuelve alertas según lo medido, y avisa solo cuando algo cambia o sigue crítico. */
  private async reconcile(checks: CheckResult[], s: HealthSettingsValues): Promise<void> {
    const now = new Date();
    for (const c of checks) {
      const [open] = await this.db
        .select()
        .from(healthAlerts)
        .where(and(eq(healthAlerts.checkKey, c.key), isNull(healthAlerts.resolvedAt)));
      if (c.level === 'UNKNOWN') continue;
      if (c.level === 'OK') {
        if (!open) continue;
        await this.db
          .update(healthAlerts)
          .set({ resolvedAt: now, updatedAt: now, message: c.message })
          .where(eq(healthAlerts.id, open.id));
        await this.notify(c, 'RESUELTO');
        continue;
      }
      if (!open) {
        const [row] = await this.db
          .insert(healthAlerts)
          .values({ checkKey: c.key, level: c.level, message: c.message })
          .onConflictDoNothing()
          .returning({ id: healthAlerts.id });
        if (row && (await this.notify(c, c.level)))
          await this.db
            .update(healthAlerts)
            .set({ lastNotifiedAt: now })
            .where(eq(healthAlerts.id, row.id));
        continue;
      }
      const worsened = open.level === 'WARN' && c.level === 'CRIT';
      const due =
        c.level === 'CRIT' &&
        (!open.lastNotifiedAt ||
          now.getTime() - open.lastNotifiedAt.getTime() >= s.renotifyMin * 60_000);
      await this.db
        .update(healthAlerts)
        .set({ level: c.level, message: c.message, updatedAt: now })
        .where(eq(healthAlerts.id, open.id));
      if ((worsened || due || !open.lastNotifiedAt) && (await this.notify(c, c.level)))
        await this.db
          .update(healthAlerts)
          .set({ lastNotifiedAt: now })
          .where(eq(healthAlerts.id, open.id));
    }
  }

  /** Con la base de datos caída solo se avisa de lo crítico, sin repetir antes del intervalo de reenvío. */
  private async notifyFromMemory(checks: CheckResult[], s: HealthSettingsValues): Promise<void> {
    for (const c of checks) {
      if (c.level !== 'CRIT') continue;
      const prev = this.memNotified.get(c.key);
      if (prev && Date.now() - prev.at < s.renotifyMin * 60_000) continue;
      if (await this.notify(c, 'CRIT'))
        this.memNotified.set(c.key, { level: 'CRIT', at: Date.now() });
    }
  }

  async recipients(): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const extra = parseRecipients(
      (await this.getSettings().catch(() => DEFAULT_SETTINGS)).extraRecipients,
    );
    const rows = await this.db
      .selectDistinct({ email: accounts.email })
      .from(accounts)
      .innerJoin(roleAssignments, eq(roleAssignments.accountId, accounts.id))
      .where(
        and(
          eq(accounts.status, 'ACTIVA'),
          inArray(roleAssignments.role, [...ADMIN_ROLES]),
          lte(roleAssignments.validFrom, today),
          or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)),
        ),
      )
      .catch(() => [] as { email: string }[]);
    return [...new Set([...rows.map((r) => r.email.toLowerCase()), ...extra])];
  }

  /** Envía el aviso a los administradores. Devuelve true si al menos un envío salió bien. */
  private async notify(c: CheckResult, kind: 'WARN' | 'CRIT' | 'RESUELTO'): Promise<boolean> {
    const to = await this.recipients();
    if (to.length === 0) {
      this.log.warn(`Alerta ${c.key} (${kind}) sin destinatarios.`);
      return false;
    }
    const tag = kind === 'CRIT' ? 'CRÍTICO' : kind === 'WARN' ? 'AVISO' : 'RESUELTO';
    const text = `${c.label}: ${c.message}\n\nEstado: ${tag}\nFecha: ${new Date().toISOString()}\n\nRevise Administración → Salud del sistema en NOMFLOW.`;
    const results = await Promise.allSettled(
      to.map((addr) => this.mailer.send(addr, `[NOMFLOW] ${tag}: ${c.label}`, text)),
    );
    for (const r of results)
      if (r.status === 'rejected')
        this.log.error(
          `No se pudo enviar la alerta a un destinatario: ${(r.reason as Error).message}`,
        );
    return results.some((r) => r.status === 'fulfilled');
  }

  async history(limit = 50) {
    return this.db.select().from(healthAlerts).orderBy(desc(healthAlerts.openedAt)).limit(limit);
  }
}
