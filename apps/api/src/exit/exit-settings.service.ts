import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, exitSettings } from '../db/schema';

export type ExitSettingsErrorCode = 'INVALID_SETTINGS';

export class ExitSettingsError extends Error {
  constructor(readonly code: ExitSettingsErrorCode) {
    super(code);
  }
}

export interface ExitSettingsInput {
  preBajaAvisoDias: number;
  zipExpiryDays: number;
}

const MAX_AVISO_DIAS = 90;
const MAX_EXPIRY_DAYS = 90;

function validate(i: ExitSettingsInput): boolean {
  return (
    Number.isInteger(i.preBajaAvisoDias) &&
    i.preBajaAvisoDias >= 0 &&
    i.preBajaAvisoDias <= MAX_AVISO_DIAS &&
    Number.isInteger(i.zipExpiryDays) &&
    i.zipExpiryDays >= 1 &&
    i.zipExpiryDays <= MAX_EXPIRY_DAYS
  );
}

async function audit(db: Db, actor: string, action: string, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'exit_settings', resourceId: null, result });
}

export async function getSettings(db: Db) {
  const [s] = await db.select().from(exitSettings).where(eq(exitSettings.id, 1));
  if (s) return s;
  return {
    id: 1,
    preBajaAvisoDias: 15,
    zipExpiryDays: 7,
    updatedBy: null,
    updatedAt: null,
  };
}

export async function saveSettings(db: Db, actor: string, input: ExitSettingsInput) {
  if (!validate(input)) {
    await audit(db, actor, 'EXIT_SETTINGS_UPDATE', 'INVALID_SETTINGS');
    throw new ExitSettingsError('INVALID_SETTINGS');
  }
  const values = {
    preBajaAvisoDias: input.preBajaAvisoDias,
    zipExpiryDays: input.zipExpiryDays,
    updatedBy: actor,
    updatedAt: new Date(),
  };
  await db
    .insert(exitSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: exitSettings.id, set: values });
  invalidateExitCache();
  await audit(db, actor, 'EXIT_SETTINGS_UPDATE', 'SUCCESS');
}

/* ---- caché breve de la configuración usada por los monitores ---- */

let cache: { at: number; cfg: { preBajaAvisoDias: number; zipExpiryDays: number } } | null = null;
const TTL_MS = 30_000;

export function invalidateExitCache(): void {
  cache = null;
}

export async function cachedExitSettings(
  db: Db,
): Promise<{ preBajaAvisoDias: number; zipExpiryDays: number }> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  const s = await getSettings(db);
  const cfg = { preBajaAvisoDias: s.preBajaAvisoDias, zipExpiryDays: s.zipExpiryDays };
  cache = { at: Date.now(), cfg };
  return cfg;
}
