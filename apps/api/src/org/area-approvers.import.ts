import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, catalogEntries, importBatchRows, importBatches } from '../db/schema';
import {
  ImportError,
  MAX_STORED_ERRORS,
  getBatch,
  type BatchSummary,
} from '../imports/imports.service';
import { setAreaApprovers } from './area-approvers.service';
import { parseAreaApproversWorkbook, type AreaApproverRow } from './area-approvers.parser';

export const AREA_APPROVERS_TYPE = 'AREA_APPROVERS';

const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'import_batch', resourceId: id, result });
}

export interface AreaApproversUploadInput {
  buffer: Buffer;
  fileName: string;
  sheet?: string | undefined;
  sourceSystem: string;
  responsible: string;
  maxRows: number;
}

/** Fila ya resuelta: cédula -> cuenta, con el motivo si el jefe o el director no se puede asignar. */
interface ResolvedRow extends AreaApproverRow {
  jefeAccountId: string | null;
  jefeSkip: string | null;
  directorAccountId: string | null;
  directorSkip: string | null;
  areaExists: boolean;
}

async function resolveRows(db: Db, rows: AreaApproverRow[]): Promise<ResolvedRow[]> {
  const ides = [
    ...new Set(rows.flatMap((r) => [r.jefe, r.director]).filter((x): x is string => x !== null)),
  ];
  const found = ides.length
    ? await db
        .select({ id: accounts.id, nIde: accounts.nIde, status: accounts.status })
        .from(accounts)
        .where(inArray(accounts.nIde, ides))
    : [];
  const byNIde = new Map(found.map((a) => [a.nIde, a]));
  const areas = await db
    .select({ cEmp: catalogEntries.cEmp, code: catalogEntries.code })
    .from(catalogEntries)
    .where(eq(catalogEntries.type, 'AREA'));
  const areaSet = new Set(areas.map((a) => `${a.cEmp}\u0000${a.code}`));

  const resolve = (nIde: string | null): [string | null, string | null] => {
    if (nIde === null) return [null, null];
    const a = byNIde.get(nIde);
    if (!a) return [null, `${nIde} no tiene cuenta en el sistema`];
    if (a.status !== 'ACTIVA') return [null, `${nIde} tiene cuenta sin activar`];
    return [a.id, null];
  };
  return rows.map((r) => {
    const [jefeAccountId, jefeSkip] = resolve(r.jefe);
    const [directorAccountId, directorSkip] = resolve(r.director);
    return {
      ...r,
      jefeAccountId,
      jefeSkip,
      directorAccountId,
      directorSkip,
      areaExists: areaSet.has(`${r.cEmp}\u0000${r.cArea}`),
    };
  });
}

export async function uploadAreaApprovers(
  db: Db,
  actorId: string,
  input: AreaApproversUploadInput,
): Promise<BatchSummary> {
  if (!isZip(input.buffer)) throw new ImportError('NOT_XLSX');
  const fileHash = createHash('sha256').update(input.buffer).digest('hex');
  const [applied] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.type, AREA_APPROVERS_TYPE),
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
    parsed = await parseAreaApproversWorkbook(input.buffer, {
      sheet: input.sheet,
      maxRows: input.maxRows,
    });
  } catch {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'NOT_XLSX');
    throw new ImportError('NOT_XLSX');
  }

  const errors = [...parsed.errors];
  if (errors.length === 0 && parsed.rows.length === 0) {
    errors.push({ row: 0, column: '', value: null, rule: 'el archivo no contiene áreas' });
  }
  const resolved = errors.length === 0 ? await resolveRows(db, parsed.rows) : [];
  for (const r of resolved) {
    if (!r.areaExists)
      errors.push({
        row: r.rowNumber,
        column: 'CDGO_AREA',
        value: r.cArea,
        rule: 'el área no existe en el catálogo de esa empresa',
      });
  }

  const skipped = resolved.filter(
    (r) => r.jefeSkip || r.directorSkip || r.directorClearedSamePerson,
  );
  const stats = {
    sheet: parsed.sheetName,
    areas: resolved.length,
    jefesAsignables: resolved.filter((r) => r.jefeAccountId).length,
    directoresAsignables: resolved.filter((r) => r.directorAccountId).length,
    sinJefeAsignable: resolved.filter((r) => r.jefe !== null && !r.jefeAccountId).length,
    sinDirectorAsignable: resolved.filter((r) => r.director !== null && !r.directorAccountId)
      .length,
    contentHash: createHash('sha256')
      .update(JSON.stringify(resolved.map((r) => [r.cEmp, r.cArea, r.jefe, r.director])))
      .digest('hex'),
    // motivos por los que una persona nombrada en el archivo no se asigna (cuenta inexistente o inactiva)
    warnings: parsed.warnings.length,
    detalle: skipped.slice(0, 50).map((r) => ({
      area: `${r.cArea} - ${r.nombreArea}`,
      jefe: r.jefeSkip,
      director:
        r.directorSkip ??
        (r.directorClearedSamePerson ? 'igual al jefe: sin director asignado' : null),
    })),
  };
  const status = errors.length === 0 ? 'LISTO' : 'OBSERVADO';
  const [batch] = await db
    .insert(importBatches)
    .values({
      type: AREA_APPROVERS_TYPE,
      status,
      fileHash,
      fileName: input.fileName.slice(0, 200),
      sheetName: parsed.sheetName,
      sourceSystem: input.sourceSystem,
      responsible: input.responsible,
      createdBy: actorId,
      rowCount: parsed.rows.length,
      stats,
      errors: errors.slice(0, MAX_STORED_ERRORS),
      errorCount: errors.length,
    })
    .returning({ id: importBatches.id });
  if (!batch) throw new Error('lote no creado');
  if (status === 'LISTO') {
    await db.insert(importBatchRows).values(
      resolved.map((r) => ({
        batchId: batch.id,
        rowNumber: r.rowNumber,
        data: r as unknown as Record<string, unknown>,
      })),
    );
  }
  await audit(db, actorId, 'IMPORT_UPLOAD', batch.id, status);
  return {
    id: batch.id,
    type: AREA_APPROVERS_TYPE,
    status,
    rowCount: parsed.rows.length,
    errorCount: errors.length,
    stats,
  };
}

export async function applyAreaApproversBatch(
  db: Db,
  actorId: string,
  batchId: string,
): Promise<BatchSummary> {
  const [head] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!head) throw new ImportError('NOT_FOUND');
  if (head.status !== 'LISTO') throw new ImportError('NOT_READY');
  const stats = head.stats as { contentHash: string };

  const staged = (
    await db.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId))
  )
    .map((s) => s.data as unknown as ResolvedRow)
    .sort((a, b) => a.rowNumber - b.rowNumber);
  if (staged.length !== head.rowCount) throw new ImportError('APPLY_FAILED');
  const hash = createHash('sha256')
    .update(JSON.stringify(staged.map((r) => [r.cEmp, r.cArea, r.jefe, r.director])))
    .digest('hex');
  if (hash !== stats.contentHash) throw new ImportError('APPLY_FAILED');

  const claimed = await db
    .update(importBatches)
    .set({ status: 'APLICANDO' })
    .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')))
    .returning({ id: importBatches.id });
  if (claimed.length === 0) throw new ImportError('NOT_READY');

  let applied = 0;
  try {
    for (const row of staged) {
      // Solo se toca lo que el archivo puede resolver: sin cambio no hay llamada ni auditoría de más.
      const clearDirector = row.directorClearedSamePerson && row.jefeAccountId !== null;
      if (row.jefeAccountId === null && row.directorAccountId === null && !clearDirector) continue;
      await setAreaApprovers(db, actorId, row.cEmp, row.cArea, {
        ...(row.jefe !== null ? { managerAccountId: row.jefeAccountId } : {}),
        ...(row.director !== null || clearDirector
          ? { directorAccountId: row.directorAccountId }
          : {}),
      });
      applied++;
    }
    await db
      .update(importBatches)
      .set({
        status: 'APLICADO',
        confirmedBy: actorId,
        appliedAt: new Date(),
        stats: { ...(head.stats as object), areasActualizadas: applied },
      })
      .where(eq(importBatches.id, batchId));
  } catch (e) {
    await db.update(importBatches).set({ status: 'FALLIDO' }).where(eq(importBatches.id, batchId));
    await audit(db, actorId, 'IMPORT_APPLY', batchId, e instanceof ImportError ? e.code : 'ERROR');
    throw e;
  }
  await audit(db, actorId, 'IMPORT_APPLY', batchId, 'SUCCESS');
  return getBatch(db, batchId);
}
