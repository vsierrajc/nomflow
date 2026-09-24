import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, employeeSnapshots, taxCertificates } from '../db/schema';

export const FILE_RE = /^([A-Za-z0-9]{1,30})_(\d{4})\.pdf$/i;
export const MAX_PDF_BYTES = Number(process.env.TAX_CERT_MAX_BYTES ?? 5 * 1024 * 1024);
const MIN_YEAR = 2000;

export type ProcessResult =
  | 'CARGADO'
  | 'SIN_CAMBIOS'
  | 'NOMBRE_INVALIDO'
  | 'ANIO_INVALIDO'
  | 'EMPLEADO_NO_EXISTE'
  | 'NO_ES_PDF'
  | 'DEMASIADO_GRANDE'
  | 'ERROR';

export interface ProcessedFile {
  file: string;
  result: ProcessResult;
}

export function inboxDir(): string {
  return process.env.TAX_CERT_INBOX_DIR ?? join(process.cwd(), 'data', 'certificados-retencion');
}

export function parseFileName(name: string): { nIde: string; year: number } | null {
  const m = FILE_RE.exec(name);
  if (!m?.[1] || !m[2]) return null;
  return { nIde: m[1], year: Number(m[2]) };
}

export function isPdf(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

async function moveTo(dir: string, name: string, base: string): Promise<void> {
  const target = join(base, dir);
  await mkdir(target, { recursive: true });
  await rename(join(base, name), join(target, `${Date.now()}-${name}`));
}

async function storeOne(
  db: Db,
  actor: string,
  nIde: string,
  year: number,
  fileName: string,
  buf: Buffer,
): Promise<ProcessResult> {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tax:${nIde}:${year}`}))`);
    const [current] = await tx
      .select({
        id: taxCertificates.id,
        sha256: taxCertificates.sha256,
        version: taxCertificates.version,
      })
      .from(taxCertificates)
      .where(
        and(
          eq(taxCertificates.nIde, nIde),
          eq(taxCertificates.year, year),
          eq(taxCertificates.active, true),
        ),
      );
    if (current?.sha256 === sha256) return 'SIN_CAMBIOS';
    if (current)
      await tx
        .update(taxCertificates)
        .set({ active: false })
        .where(eq(taxCertificates.id, current.id));
    await tx.insert(taxCertificates).values({
      nIde,
      year,
      version: (current?.version ?? 0) + 1,
      data: buf,
      sha256,
      sizeBytes: buf.length,
      fileName,
      uploadedBy: actor,
    });
    return 'CARGADO';
  });
}

async function classify(db: Db, actor: string, base: string, name: string): Promise<ProcessResult> {
  const parsed = parseFileName(name);
  if (!parsed) return 'NOMBRE_INVALIDO';
  if (parsed.year < MIN_YEAR || parsed.year > new Date().getFullYear()) return 'ANIO_INVALIDO';
  if ((await stat(join(base, name))).size > MAX_PDF_BYTES) return 'DEMASIADO_GRANDE';
  const buf = await readFile(join(base, name));
  if (!isPdf(buf)) return 'NO_ES_PDF';
  const [emp] = await db
    .select({ n: employeeSnapshots.nIde })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, parsed.nIde))
    .limit(1);
  if (!emp) return 'EMPLEADO_NO_EXISTE';
  return storeOne(db, actor, parsed.nIde, parsed.year, name, buf);
}

/** Procesa los PDF de la carpeta de entrada: los válidos van a procesados/ y los demás a rechazados/. */
export async function processInbox(db: Db, actor: string): Promise<ProcessedFile[]> {
  const base = inboxDir();
  await mkdir(base, { recursive: true });
  const out: ProcessedFile[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    let result: ProcessResult;
    try {
      result = await classify(db, actor, base, entry.name);
    } catch {
      result = 'ERROR';
    }
    if (result !== 'ERROR') {
      const ok = result === 'CARGADO' || result === 'SIN_CAMBIOS';
      await moveTo(ok ? 'procesados' : 'rechazados', entry.name, base);
    } // ERROR: se deja en la carpeta para reintentar
    out.push({ file: entry.name, result });
  }
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action: 'TAX_CERT_PROCESS',
    resource: 'tax_certificates',
    result: 'OK',
    context: {
      total: out.length,
      cargados: out.filter((r) => r.result === 'CARGADO').length,
      rechazados: out.filter((r) => !['CARGADO', 'SIN_CAMBIOS', 'ERROR'].includes(r.result)).length,
    },
  });
  return out;
}

export async function listAll(db: Db, nIde?: string) {
  return db
    .select({
      id: taxCertificates.id,
      nIde: taxCertificates.nIde,
      year: taxCertificates.year,
      version: taxCertificates.version,
      active: taxCertificates.active,
      sizeBytes: taxCertificates.sizeBytes,
      fileName: taxCertificates.fileName,
      uploadedAt: taxCertificates.uploadedAt,
    })
    .from(taxCertificates)
    .where(nIde ? eq(taxCertificates.nIde, nIde) : undefined)
    .orderBy(desc(taxCertificates.uploadedAt))
    .limit(500);
}

async function myNIde(db: Db, accountId: string): Promise<string | null> {
  const [a] = await db
    .select({ n: accounts.nIde })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return a?.n ?? null;
}

export async function listMine(db: Db, accountId: string) {
  const nIde = await myNIde(db, accountId);
  if (!nIde) return [];
  return db
    .select({
      year: taxCertificates.year,
      sizeBytes: taxCertificates.sizeBytes,
      uploadedAt: taxCertificates.uploadedAt,
    })
    .from(taxCertificates)
    .where(and(eq(taxCertificates.nIde, nIde), eq(taxCertificates.active, true)))
    .orderBy(desc(taxCertificates.year));
}

export async function getMine(db: Db, accountId: string, year: number) {
  const nIde = await myNIde(db, accountId);
  const [row] = nIde
    ? await db
        .select({ data: taxCertificates.data })
        .from(taxCertificates)
        .where(
          and(
            eq(taxCertificates.nIde, nIde),
            eq(taxCertificates.year, year),
            eq(taxCertificates.active, true),
          ),
        )
    : [];
  await db.insert(auditLogs).values({
    actorAccountId: accountId,
    action: 'TAX_CERT_DOWNLOAD',
    resource: 'tax_certificates',
    resourceId: String(year),
    result: row ? 'OK' : 'NOT_FOUND',
  });
  return row ? { data: row.data, fileName: `certificado-retencion-${year}.pdf` } : null;
}
