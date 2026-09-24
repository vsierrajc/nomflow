import { createHash } from 'node:crypto';
import { and, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, importBatchRows, importBatches, payrollConcepts } from '../db/schema';
import {
  ImportError,
  MAX_STORED_ERRORS,
  getBatch,
  type BatchSummary,
} from '../imports/imports.service';
import { parseConceptsWorkbook, type ConceptRow } from './concepts.parser';
import { UNIT_RE } from './units';

export const CONCEPT_TYPE = 'CONCEPTO';

export class ConceptError extends Error {
  constructor(readonly code: 'EXISTS' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'INVALID_UNIT') {
    super(code);
  }
}

const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
  resource = 'payroll_concept',
) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource, resourceId, result });
}

export interface ConceptUploadInput {
  buffer: Buffer;
  fileName: string;
  sheet?: string | undefined;
  sourceSystem: string;
  responsible: string;
  maxRows: number;
}

export async function uploadConcepts(
  db: Db,
  actorId: string,
  input: ConceptUploadInput,
): Promise<BatchSummary> {
  if (!isZip(input.buffer)) throw new ImportError('NOT_XLSX');
  const fileHash = createHash('sha256').update(input.buffer).digest('hex');
  const [applied] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.type, CONCEPT_TYPE),
        eq(importBatches.fileHash, fileHash),
        eq(importBatches.status, 'APLICADO'),
      ),
    )
    .limit(1);
  if (applied) {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'DUPLICATE_FILE', 'import_batch');
    throw new ImportError('DUPLICATE_FILE');
  }
  let parsed;
  try {
    parsed = await parseConceptsWorkbook(input.buffer, {
      sheet: input.sheet,
      maxRows: input.maxRows,
    });
  } catch {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'NOT_XLSX', 'import_batch');
    throw new ImportError('NOT_XLSX');
  }
  const existing = await db.select().from(payrollConcepts);
  const byCode = new Map(existing.map((c) => [c.code, c]));
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  for (const row of parsed.rows) {
    const prev = byCode.get(row.code);
    if (!prev) created++;
    else if (prev.name !== row.name || prev.unit !== row.unit) changed++;
    else unchanged++;
  }
  const inFile = new Set(parsed.rows.map((r) => r.code));
  const units = [...new Set(parsed.rows.map((r) => r.unit))].sort();
  const stats = {
    sheet: parsed.sheetName,
    created,
    changed,
    unchanged,
    units,
    missingInFile: existing.filter((c) => !inFile.has(c.code)).length,
    warnings: parsed.warnings.length,
  };
  const status = parsed.errors.length === 0 ? 'LISTO' : 'OBSERVADO';
  const [batch] = await db
    .insert(importBatches)
    .values({
      type: CONCEPT_TYPE,
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
  await audit(db, actorId, 'IMPORT_UPLOAD', batch.id, status, 'import_batch');
  return {
    id: batch.id,
    type: CONCEPT_TYPE,
    status,
    rowCount: parsed.rows.length,
    errorCount: parsed.errors.length,
    stats,
  };
}

export async function applyConceptsBatch(
  db: Db,
  actorId: string,
  batchId: string,
): Promise<BatchSummary> {
  const [head] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!head) throw new ImportError('NOT_FOUND');
  if (head.status !== 'LISTO') throw new ImportError('NOT_READY');
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('import:CONCEPTO'))`);
      const claimed = await tx
        .update(importBatches)
        .set({ status: 'APLICANDO' })
        .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')))
        .returning({ id: importBatches.id });
      if (claimed.length === 0) throw new ImportError('NOT_READY');
      const rows = (
        await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId))
      ).map((s) => s.data as ConceptRow);
      for (const row of rows) {
        await tx
          .insert(payrollConcepts)
          .values({ code: row.code, name: row.name, unit: row.unit, active: true, batchId })
          .onConflictDoUpdate({
            target: payrollConcepts.code,
            set: {
              name: row.name,
              unit: row.unit,
              active: true,
              batchId,
              version: sql`${payrollConcepts.version} + 1`,
              updatedAt: new Date(),
            },
          });
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(payrollConcepts)
        .where(eq(payrollConcepts.batchId, batchId));
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
    await audit(
      db,
      actorId,
      'IMPORT_APPLY',
      batchId,
      e instanceof ImportError ? e.code : 'ERROR',
      'import_batch',
    );
    throw e;
  }
  await audit(db, actorId, 'IMPORT_APPLY', batchId, 'SUCCESS', 'import_batch');
  return getBatch(db, batchId);
}

export interface ConceptListQuery {
  q?: string | undefined;
  active?: boolean | undefined;
  unit?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listConcepts(db: Db, query: ConceptListQuery) {
  const filters: SQL[] = [];
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const cond = or(ilike(payrollConcepts.code, like), ilike(payrollConcepts.name, like));
    if (cond) filters.push(cond);
  }
  if (query.active !== undefined) filters.push(eq(payrollConcepts.active, query.active));
  if (query.unit) filters.push(eq(payrollConcepts.unit, query.unit));
  const where = filters.length ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(payrollConcepts)
    .where(where);
  const items = await db
    .select({
      id: payrollConcepts.id,
      code: payrollConcepts.code,
      name: payrollConcepts.name,
      unit: payrollConcepts.unit,
      active: payrollConcepts.active,
      version: payrollConcepts.version,
      updatedAt: payrollConcepts.updatedAt,
    })
    .from(payrollConcepts)
    .where(where)
    .orderBy(payrollConcepts.code)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { total: Number(total), page: query.page, pageSize: query.pageSize, items };
}

export async function createConcept(
  db: Db,
  actorId: string,
  input: { code: string; name: string; unit: string },
) {
  const unit = input.unit.trim().toUpperCase();
  if (!UNIT_RE.test(unit)) throw new ConceptError('INVALID_UNIT');
  const inserted = await db
    .insert(payrollConcepts)
    .values({ code: input.code.trim(), name: input.name.replace(/\s+/g, ' ').trim(), unit })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) throw new ConceptError('EXISTS');
  await audit(db, actorId, 'CONCEPT_CREATE', row.id, 'SUCCESS');
  return row;
}

export async function updateConcept(
  db: Db,
  actorId: string,
  id: string,
  input: { name: string; unit: string; active: boolean; version: number },
) {
  const unit = input.unit.trim().toUpperCase();
  if (!UNIT_RE.test(unit)) throw new ConceptError('INVALID_UNIT');
  const updated = await db
    .update(payrollConcepts)
    .set({
      name: input.name.replace(/\s+/g, ' ').trim(),
      unit,
      active: input.active,
      version: sql`${payrollConcepts.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(payrollConcepts.id, id), eq(payrollConcepts.version, input.version)))
    .returning();
  const row = updated[0];
  if (!row) {
    const [exists] = await db
      .select({ id: payrollConcepts.id })
      .from(payrollConcepts)
      .where(eq(payrollConcepts.id, id));
    throw new ConceptError(exists ? 'VERSION_CONFLICT' : 'NOT_FOUND');
  }
  await audit(db, actorId, 'CONCEPT_UPDATE', id, 'SUCCESS');
  return row;
}

export async function conceptUnits(
  db: Pick<Db, 'select'>,
  codes: string[],
): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const rows = await db
    .select({ code: payrollConcepts.code, unit: payrollConcepts.unit })
    .from(payrollConcepts)
    .where(inArray(payrollConcepts.code, codes));
  return new Map(rows.map((r) => [r.code, r.unit]));
}
