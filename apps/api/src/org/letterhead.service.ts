import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, companies, companyLetterheads } from '../db/schema';
import { inspectImage } from './logos.service';

/** Página tipo carta (Letter) en puntos: 8,5 x 11 pulgadas. */
export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const MAX_LETTERHEAD_BYTES = 600 * 1024;
export const MIN_LETTERHEAD_WIDTH = 1000;
export const MAX_LETTERHEAD_WIDTH = 5000;
/** Alto máximo, en puntos, cuando la imagen se estira al ancho de la página. */
export const MAX_HEIGHT_PT = { HEADER: 130, FOOTER: 100 } as const;

export type LetterheadKind = 'HEADER' | 'FOOTER';
export const KINDS: readonly LetterheadKind[] = ['HEADER', 'FOOTER'];

export type LetterheadErrorCode =
  | 'COMPANY_NOT_FOUND'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'INVALID_IMAGE'
  | 'INVALID_DIMENSIONS'
  | 'TOO_TALL';

export class LetterheadError extends Error {
  constructor(readonly code: LetterheadErrorCode) {
    super(code);
  }
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'company_letterhead',
    resourceId,
    result,
  });
}

async function ensureCompany(db: Pick<Db, 'select'>, companyId: string) {
  const [c] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!c) throw new LetterheadError('COMPANY_NOT_FOUND');
}

export async function uploadLetterhead(
  db: Db,
  actorId: string,
  companyId: string,
  kind: LetterheadKind,
  file: Buffer,
) {
  const fail = async (code: LetterheadErrorCode): Promise<never> => {
    await audit(db, actorId, 'LETTERHEAD_UPLOAD', companyId, `${kind}:${code}`);
    throw new LetterheadError(code);
  };
  await ensureCompany(db, companyId);
  if (file.length > MAX_LETTERHEAD_BYTES) return fail('TOO_LARGE');
  const info = inspectImage(file);
  if (!info) return fail('INVALID_IMAGE');
  if (info.width < MIN_LETTERHEAD_WIDTH || info.width > MAX_LETTERHEAD_WIDTH || info.height < 1)
    return fail('INVALID_DIMENSIONS');
  if ((PAGE_WIDTH * info.height) / info.width > MAX_HEIGHT_PT[kind]) return fail('TOO_TALL');
  const values = {
    contentType: info.contentType,
    data: file,
    sha256: createHash('sha256').update(file).digest('hex'),
    width: info.width,
    height: info.height,
    uploadedBy: actorId,
    uploadedAt: new Date(),
  };
  await db
    .insert(companyLetterheads)
    .values({ companyId, kind, ...values })
    .onConflictDoUpdate({
      target: [companyLetterheads.companyId, companyLetterheads.kind],
      set: values,
    });
  await audit(db, actorId, 'LETTERHEAD_UPLOAD', companyId, `${kind}:SUCCESS`);
  return { kind, contentType: info.contentType, width: info.width, height: info.height };
}

export async function letterheadStatus(db: Db, companyId: string) {
  await ensureCompany(db, companyId);
  const rows = await db
    .select({
      kind: companyLetterheads.kind,
      contentType: companyLetterheads.contentType,
      width: companyLetterheads.width,
      height: companyLetterheads.height,
      uploadedAt: companyLetterheads.uploadedAt,
    })
    .from(companyLetterheads)
    .where(eq(companyLetterheads.companyId, companyId));
  return KINDS.map((k) => ({ kind: k, image: rows.find((r) => r.kind === k) ?? null }));
}

export async function letterheadImage(db: Db, companyId: string, kind: LetterheadKind) {
  const [row] = await db
    .select()
    .from(companyLetterheads)
    .where(and(eq(companyLetterheads.companyId, companyId), eq(companyLetterheads.kind, kind)));
  if (!row) throw new LetterheadError('NOT_FOUND');
  return row;
}

export async function removeLetterhead(
  db: Db,
  actorId: string,
  companyId: string,
  kind: LetterheadKind,
) {
  await ensureCompany(db, companyId);
  await db
    .delete(companyLetterheads)
    .where(and(eq(companyLetterheads.companyId, companyId), eq(companyLetterheads.kind, kind)));
  await audit(db, actorId, 'LETTERHEAD_REMOVE', companyId, `${kind}:SUCCESS`);
}

export interface Letterhead {
  data: Buffer;
  /** Alto que ocupa al estirarla al ancho de la página. */
  heightPt: number;
}

/** Encabezado y pie de la empresa para los PDF; `null` en cada uno si no se han cargado. */
export async function letterheadForCompanyCode(
  db: Pick<Db, 'select'>,
  cEmp: string | null | undefined,
): Promise<{ header: Letterhead | null; footer: Letterhead | null }> {
  const none = { header: null, footer: null };
  if (!cEmp) return none;
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.cEmp, cEmp));
  if (!company) return none;
  const rows = await db
    .select()
    .from(companyLetterheads)
    .where(eq(companyLetterheads.companyId, company.id));
  const pick = (k: LetterheadKind): Letterhead | null => {
    const r = rows.find((x) => x.kind === k);
    return r ? { data: r.data, heightPt: (PAGE_WIDTH * r.height) / r.width } : null;
  };
  return { header: pick('HEADER'), footer: pick('FOOTER') };
}
