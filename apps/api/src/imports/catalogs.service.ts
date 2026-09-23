import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLogs,
  catalogEntries,
  catalogEntryHistory,
  companies,
  importBatchRows,
  importBatches,
} from '../db/schema';
import {
  CATALOGS,
  parseCatalogWorkbook,
  type CatalogKind,
  type CatalogRow,
} from './catalog.parser';
import { ImportError, MAX_STORED_ERRORS, getBatch, type BatchSummary } from './imports.service';

export interface CatalogUploadInput {
  buffer: Buffer;
  fileName: string;
  sheet?: string | undefined;
  cEmp?: string | undefined;
  sourceSystem: string;
  responsible: string;
  maxRows: number;
}

const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function audit(
  db: Db,
  actor: string,
  action: string,
  batchId: string | null,
  result: string,
) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'import_batch',
    resourceId: batchId,
    result,
  });
}

export async function uploadCatalog(
  db: Db,
  actorId: string,
  kind: CatalogKind,
  input: CatalogUploadInput,
): Promise<BatchSummary> {
  if (!isZip(input.buffer)) throw new ImportError('NOT_XLSX');
  const def = CATALOGS[kind];
  const cEmp = def.global ? '' : (input.cEmp ?? '').trim();
  if (!def.global) {
    if (!cEmp) throw new ImportError('COMPANY_REQUIRED');
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.cEmp, cEmp), eq(companies.active, true)));
    if (!company) throw new ImportError('COMPANY_NOT_FOUND');
  }

  const fileHash = createHash('sha256').update(input.buffer).update(`|${cEmp}`).digest('hex');
  const [applied] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.type, kind),
        eq(importBatches.fileHash, fileHash),
        eq(importBatches.status, 'APLICADO'),
      ),
    )
    .limit(1);
  if (applied) {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'DUPLICATE_FILE');
    throw new ImportError('DUPLICATE_FILE');
  }

  let parsed;
  try {
    parsed = await parseCatalogWorkbook(input.buffer, kind, {
      sheet: input.sheet,
      maxRows: input.maxRows,
    });
  } catch {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'NOT_XLSX');
    throw new ImportError('NOT_XLSX');
  }

  const existing = await db
    .select()
    .from(catalogEntries)
    .where(and(eq(catalogEntries.type, kind), eq(catalogEntries.cEmp, cEmp)));
  const byCode = new Map(existing.map((e) => [e.code, e]));
  let created = 0;
  let renamed = 0;
  let unchanged = 0;
  for (const row of parsed.rows) {
    const prev = byCode.get(row.code);
    if (!prev) created++;
    else if (prev.name !== row.name) renamed++;
    else unchanged++;
  }
  const inFile = new Set(parsed.rows.map((r) => r.code));
  const stats = {
    sheet: parsed.sheetName,
    cEmp,
    created,
    renamed,
    unchanged,
    missingInFile: existing.filter((e) => !inFile.has(e.code)).length,
    warnings: parsed.warnings.length,
  };
  const status = parsed.errors.length === 0 ? 'LISTO' : 'OBSERVADO';
  const [batch] = await db
    .insert(importBatches)
    .values({
      type: kind,
      status,
      fileHash,
      fileName: input.fileName.slice(0, 200),
      sheetName: parsed.sheetName,
      sourceSystem: input.sourceSystem,
      responsible: input.responsible,
      createdBy: actorId,
      rowCount: parsed.rows.length,
      stats,
      errors: parsed.errors.slice(0, MAX_STORED_ERRORS),
      errorCount: parsed.errors.length,
    })
    .returning({ id: importBatches.id });
  if (!batch) throw new Error('lote no creado');
  if (status === 'LISTO' && parsed.rows.length > 0) {
    await db
      .insert(importBatchRows)
      .values(parsed.rows.map((r) => ({ batchId: batch.id, rowNumber: r.rowNumber, data: r })));
  }
  await audit(db, actorId, 'IMPORT_UPLOAD', batch.id, status);
  return {
    id: batch.id,
    type: kind,
    status,
    rowCount: parsed.rows.length,
    errorCount: parsed.errors.length,
    stats,
  };
}

export async function applyCatalogBatch(
  db: Db,
  actorId: string,
  batchId: string,
): Promise<BatchSummary> {
  const [head] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!head) throw new ImportError('NOT_FOUND');
  if (head.status !== 'LISTO') throw new ImportError('NOT_READY');
  const kind = head.type as CatalogKind;
  const cEmp = String((head.stats as { cEmp?: string }).cEmp ?? '');

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`import:${kind}:${cEmp}`}))`);
      const claimed = await tx
        .update(importBatches)
        .set({ status: 'APLICANDO' })
        .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')))
        .returning({ id: importBatches.id });
      if (claimed.length === 0) throw new ImportError('NOT_READY');

      if (cEmp) {
        const [company] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.cEmp, cEmp), eq(companies.active, true)));
        if (!company) throw new ImportError('COMPANY_NOT_FOUND');
      }
      const rows = (
        await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId))
      ).map((s) => s.data as CatalogRow);
      const existing = rows.length
        ? await tx
            .select()
            .from(catalogEntries)
            .where(
              and(
                eq(catalogEntries.type, kind),
                eq(catalogEntries.cEmp, cEmp),
                inArray(
                  catalogEntries.code,
                  rows.map((r) => r.code),
                ),
              ),
            )
        : [];
      const byCode = new Map(existing.map((e) => [e.code, e]));

      for (const row of rows) {
        const prev = byCode.get(row.code);
        if (prev && prev.name !== row.name) {
          await tx
            .insert(catalogEntryHistory)
            .values({ entryId: prev.id, oldName: prev.name, newName: row.name, batchId });
        }
        await tx
          .insert(catalogEntries)
          .values({ type: kind, cEmp, code: row.code, name: row.name, active: true, batchId })
          .onConflictDoUpdate({
            target: [catalogEntries.type, catalogEntries.cEmp, catalogEntries.code],
            set: { name: row.name, active: true, batchId, updatedAt: new Date() },
          });
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(catalogEntries)
        .where(and(eq(catalogEntries.type, kind), eq(catalogEntries.batchId, batchId)));
      if (Number(n) !== head.rowCount || rows.length !== head.rowCount)
        throw new ImportError('APPLY_FAILED');
      await tx
        .update(importBatches)
        .set({ status: 'APLICADO', confirmedBy: actorId, appliedAt: new Date() })
        .where(eq(importBatches.id, batchId));
    });
  } catch (e) {
    await db
      .update(importBatches)
      .set({ status: 'FALLIDO' })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')));
    await audit(db, actorId, 'IMPORT_APPLY', batchId, e instanceof ImportError ? e.code : 'ERROR');
    throw e;
  }
  await audit(db, actorId, 'IMPORT_APPLY', batchId, 'SUCCESS');
  return getBatch(db, batchId);
}

export async function listCatalog(db: Db, kind: CatalogKind, cEmp: string) {
  return db
    .select({ code: catalogEntries.code, name: catalogEntries.name, active: catalogEntries.active })
    .from(catalogEntries)
    .where(
      and(
        eq(catalogEntries.type, kind),
        eq(catalogEntries.cEmp, CATALOGS[kind].global ? '' : cEmp),
      ),
    )
    .orderBy(catalogEntries.code);
}
