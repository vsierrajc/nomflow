import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { archiveSettings, auditLogs } from '../db/schema';
import { open, seal } from '../security/secret-box';
import type { DeletableObjectStore } from './object-store';
import { S3ObjectStore, type S3Config } from './s3-object-store';
import type { ColdStoreProvider } from './tiered-object-store';

export const COLD_STORE_FACTORY = Symbol('COLD_STORE_FACTORY');
export type ColdStoreFactory = (config: S3Config) => DeletableObjectStore;
export const defaultColdFactory: ColdStoreFactory = (c) => new S3ObjectStore(c);

export class ArchiveSettingsError extends Error {
  constructor(readonly code: 'INVALID_SETTINGS' | 'NOT_CONFIGURED') {
    super(code);
  }
}

export interface ArchiveSettingsInput {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId?: string | null | undefined;
  /** Solo para reemplazar la clave guardada. */
  secret?: string | undefined;
  ageDays: number;
  graceDays: number;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const production = () => process.env.NODE_ENV === 'production';

function validEndpoint(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (u.protocol === 'http:' && !production());
  } catch {
    return false;
  }
}

function validate(i: ArchiveSettingsInput): boolean {
  return (
    validEndpoint(i.endpoint.trim()) &&
    /^[a-z0-9-]{2,40}$/.test(i.region.trim()) &&
    BUCKET_RE.test(i.bucket.trim()) &&
    Number.isInteger(i.ageDays) &&
    i.ageDays >= 30 &&
    i.ageDays <= 3650 &&
    Number.isInteger(i.graceDays) &&
    i.graceDays >= 0 &&
    i.graceDays <= 365 &&
    (i.accessKeyId ?? '').length <= 200 &&
    (i.secret ?? '').length <= 500
  );
}

export async function getArchiveSettings(db: Db) {
  const [s] = await db.select().from(archiveSettings).where(eq(archiveSettings.id, 1));
  const v = s ?? {
    enabled: false,
    endpoint: 'https://storage.googleapis.com',
    region: 'us-central1',
    bucket: 'nomflow',
    accessKeyId: null,
    secretEnc: null,
    ageDays: 365,
    graceDays: 0,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunSummary: null,
    updatedAt: null,
  };
  return {
    enabled: v.enabled,
    endpoint: v.endpoint,
    region: v.region,
    bucket: v.bucket,
    accessKeyId: v.accessKeyId,
    hasSecret: Boolean(v.secretEnc),
    configured: Boolean(v.accessKeyId && v.secretEnc),
    ageDays: v.ageDays,
    graceDays: v.graceDays,
    lastRunAt: v.lastRunAt,
    lastRunStatus: v.lastRunStatus,
    lastRunSummary: v.lastRunSummary,
    updatedAt: v.updatedAt,
  };
}

export async function saveArchiveSettings(
  db: Db,
  accountId: string,
  input: ArchiveSettingsInput,
): Promise<void> {
  if (!validate(input)) throw new ArchiveSettingsError('INVALID_SETTINGS');
  const [cur] = await db.select().from(archiveSettings).where(eq(archiveSettings.id, 1));
  const accessKeyId = (input.accessKeyId ?? '').trim() || cur?.accessKeyId || null;
  const secretEnc = input.secret ? seal(input.secret) : (cur?.secretEnc ?? null);
  if (input.enabled && (!accessKeyId || !secretEnc))
    throw new ArchiveSettingsError('NOT_CONFIGURED');
  const values = {
    enabled: input.enabled,
    endpoint: input.endpoint.trim(),
    region: input.region.trim(),
    bucket: input.bucket.trim(),
    accessKeyId,
    secretEnc,
    ageDays: input.ageDays,
    graceDays: input.graceDays,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(archiveSettings)
      .values({ id: 1, ...values, updatedBy: accountId })
      .onConflictDoUpdate({
        target: archiveSettings.id,
        set: { ...values, updatedBy: accountId, updatedAt: new Date() },
      });
    await tx.insert(auditLogs).values({
      actorAccountId: accountId,
      action: 'ARCHIVE_SETTINGS_UPDATE',
      resource: 'archive_settings',
      resourceId: '1',
      result: 'SUCCESS',
      // Sin la clave: solo qué cambió.
      context: {
        ...values,
        accessKeyId: Boolean(accessKeyId),
        secretEnc: undefined,
        secretChanged: Boolean(input.secret),
      },
    });
  });
}

/** Configuración S3 del almacén en la nube, o null si aún no se guardó la clave. */
export async function coldConfig(db: Db): Promise<S3Config | null> {
  const [s] = await db.select().from(archiveSettings).where(eq(archiveSettings.id, 1));
  if (!s?.accessKeyId || !s.secretEnc) return null;
  return {
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.accessKeyId,
    secretAccessKey: open(s.secretEnc),
  };
}

/** Almacén en la nube con la configuración vigente (se relee cada 30 s y al guardar). */
export class DbColdStoreProvider implements ColdStoreProvider {
  private cached: { at: number; store: DeletableObjectStore | null } | null = null;

  constructor(
    private readonly db: Db,
    private readonly factory: ColdStoreFactory,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async get(): Promise<DeletableObjectStore | null> {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.store;
    const cfg = await coldConfig(this.db);
    this.cached = { at: Date.now(), store: cfg ? this.factory(cfg) : null };
    return this.cached.store;
  }
}
