import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, companies, companyLogos } from '../db/schema';

export const MAX_LOGO_BYTES = 512 * 1024;
export const MIN_LOGO_SIDE = 64;
export const MAX_LOGO_SIDE = 2000;

export type LogoErrorCode =
  'COMPANY_NOT_FOUND' | 'NOT_FOUND' | 'TOO_LARGE' | 'INVALID_IMAGE' | 'INVALID_DIMENSIONS';

export class LogoError extends Error {
  constructor(readonly code: LogoErrorCode) {
    super(code);
  }
}

export interface ImageInfo {
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function inspectImage(buf: Buffer): ImageInfo | null {
  if (
    buf.length > 24 &&
    buf.subarray(0, 8).equals(PNG_MAGIC) &&
    buf.subarray(12, 16).toString('ascii') === 'IHDR'
  ) {
    return { contentType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1] ?? 0;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          contentType: 'image/jpeg',
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

let defaultLogo: Buffer | null = null;

export function genericLogo(): Buffer {
  defaultLogo ??= readFileSync(join(__dirname, '..', '..', 'assets', 'logo-generico.png'));
  return defaultLogo;
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'company_logo', resourceId, result });
}

async function ensureCompany(db: Pick<Db, 'select'>, companyId: string) {
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) throw new LogoError('COMPANY_NOT_FOUND');
}

export async function uploadLogo(db: Db, actorId: string, companyId: string, file: Buffer) {
  const fail = async (code: LogoErrorCode): Promise<never> => {
    await audit(db, actorId, 'LOGO_UPLOAD', companyId, code);
    throw new LogoError(code);
  };
  await ensureCompany(db, companyId);
  if (file.length > MAX_LOGO_BYTES) return fail('TOO_LARGE');
  const info = inspectImage(file);
  if (!info) return fail('INVALID_IMAGE');
  const { width, height } = info;
  if (
    width < MIN_LOGO_SIDE ||
    height < MIN_LOGO_SIDE ||
    width > MAX_LOGO_SIDE ||
    height > MAX_LOGO_SIDE
  ) {
    return fail('INVALID_DIMENSIONS');
  }

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`logo:${companyId}`}))`);
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${companyLogos.version}), 0)::int + 1` })
      .from(companyLogos)
      .where(eq(companyLogos.companyId, companyId));
    await tx
      .update(companyLogos)
      .set({ active: false })
      .where(and(eq(companyLogos.companyId, companyId), eq(companyLogos.active, true)));
    const [row] = await tx
      .insert(companyLogos)
      .values({
        companyId,
        version: Number(next),
        contentType: info.contentType,
        data: file,
        sha256: createHash('sha256').update(file).digest('hex'),
        width,
        height,
        active: true,
        uploadedBy: actorId,
      })
      .returning({
        id: companyLogos.id,
        version: companyLogos.version,
        contentType: companyLogos.contentType,
        width: companyLogos.width,
        height: companyLogos.height,
      });
    return row;
  });
  if (!created) throw new Error('logo no creado');
  await audit(db, actorId, 'LOGO_UPLOAD', created.id, 'SUCCESS');
  return created;
}

export async function listLogos(db: Db, companyId: string) {
  await ensureCompany(db, companyId);
  return db
    .select({
      id: companyLogos.id,
      version: companyLogos.version,
      contentType: companyLogos.contentType,
      width: companyLogos.width,
      height: companyLogos.height,
      sha256: companyLogos.sha256,
      active: companyLogos.active,
      uploadedAt: companyLogos.uploadedAt,
    })
    .from(companyLogos)
    .where(eq(companyLogos.companyId, companyId))
    .orderBy(desc(companyLogos.version));
}

export async function effectiveLogo(
  db: Pick<Db, 'select'>,
  companyId: string,
  logoId?: string,
): Promise<{ data: Buffer; contentType: string; sha256: string; source: 'custom' | 'default' }> {
  const [row] = await db
    .select()
    .from(companyLogos)
    .where(
      logoId
        ? and(eq(companyLogos.companyId, companyId), eq(companyLogos.id, logoId))
        : and(eq(companyLogos.companyId, companyId), eq(companyLogos.active, true)),
    );
  if (row)
    return { data: row.data, contentType: row.contentType, sha256: row.sha256, source: 'custom' };
  if (logoId) throw new LogoError('NOT_FOUND');
  const data = genericLogo();
  return {
    data,
    contentType: 'image/png',
    sha256: createHash('sha256').update(data).digest('hex'),
    source: 'default',
  };
}

export async function adminLogo(db: Db, companyId: string) {
  await ensureCompany(db, companyId);
  return effectiveLogo(db, companyId);
}

export async function logoForCompanyCode(
  db: Pick<Db, 'select'>,
  cEmp: string | null | undefined,
): Promise<Buffer> {
  if (!cEmp) return genericLogo();
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.cEmp, cEmp));
  if (!company) return genericLogo();
  return (await effectiveLogo(db, company.id)).data;
}

export async function activateLogo(db: Db, actorId: string, companyId: string, logoId: string) {
  await ensureCompany(db, companyId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`logo:${companyId}`}))`);
    const [target] = await tx
      .select({ id: companyLogos.id })
      .from(companyLogos)
      .where(and(eq(companyLogos.id, logoId), eq(companyLogos.companyId, companyId)));
    if (!target) throw new LogoError('NOT_FOUND');
    await tx
      .update(companyLogos)
      .set({ active: false })
      .where(and(eq(companyLogos.companyId, companyId), eq(companyLogos.active, true)));
    await tx.update(companyLogos).set({ active: true }).where(eq(companyLogos.id, logoId));
  });
  await audit(db, actorId, 'LOGO_ACTIVATE', logoId, 'SUCCESS');
}

export async function resetLogo(db: Db, actorId: string, companyId: string) {
  await ensureCompany(db, companyId);
  await db
    .update(companyLogos)
    .set({ active: false })
    .where(and(eq(companyLogos.companyId, companyId), eq(companyLogos.active, true)));
  await audit(db, actorId, 'LOGO_RESET', companyId, 'SUCCESS');
}
