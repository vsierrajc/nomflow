import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLogs,
  employeeSnapshots,
  importBatchRows,
  importBatches,
  progVac,
  progVacAdjustments,
} from '../db/schema';
import {
  ImportError,
  MAX_STORED_ERRORS,
  getBatch,
  type BatchSummary,
} from '../imports/imports.service';
import { isValidIsoDate } from './business-days';
import { parseProgVacWorkbook, type ProgVacRow } from './prog-vac.parser';
import { internalState } from './prog-vac.service';

export const PROG_VAC_TYPE = 'PROG_VAC';

const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'import_batch', resourceId: id, result });
}

export interface ProgVacUploadInput {
  buffer: Buffer;
  fileName: string;
  sheet?: string | undefined;
  sourceSystem: string;
  responsible: string;
  /** Fecha de corte de la carga (AAAA-MM-DD), metadato del lote. */
  fechaCorte?: string | undefined;
  maxRows: number;
}

type StoredRow = ProgVacRow & { fechaCorte: string | null };

export async function uploadProgVac(
  db: Db,
  actorId: string,
  input: ProgVacUploadInput,
): Promise<BatchSummary> {
  if (input.fechaCorte !== undefined && !isValidIsoDate(input.fechaCorte))
    throw new ImportError('INVALID_SCOPE');
  if (!isZip(input.buffer)) throw new ImportError('NOT_XLSX');
  const fileHash = createHash('sha256').update(input.buffer).digest('hex');
  const [applied] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.type, PROG_VAC_TYPE),
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
    parsed = await parseProgVacWorkbook(input.buffer, {
      sheet: input.sheet,
      maxRows: input.maxRows,
    });
  } catch {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'NOT_XLSX');
    throw new ImportError('NOT_XLSX');
  }

  const errors = [...parsed.errors];
  const employees = new Set(
    (
      await db
        .select({ i: employeeSnapshots.nIde, c: employeeSnapshots.nCont })
        .from(employeeSnapshots)
    ).map((e) => `${e.i}|${e.c}`),
  );
  const existing = new Map(
    (await db.select().from(progVac).where(eq(progVac.active, true))).map((p) => [
      `${p.nIde}|${p.nCont}|${p.perIni}|${p.perFin}`,
      p,
    ]),
  );
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  for (const row of parsed.rows) {
    if (!employees.has(`${row.nIde}|${row.nCont}`)) {
      errors.push({
        row: row.rowNumber,
        column: 'N_IDE',
        value: null,
        rule: 'no existe un empleado con ese N_IDE y N_CONT (importe primero EMPLEADOS)',
      });
      continue;
    }
    const prev = existing.get(`${row.nIde}|${row.nCont}|${row.perIni}|${row.perFin}`);
    if (!prev) created++;
    else if (prev.dias !== row.dias || prev.disp !== row.disp) changed++;
    else unchanged++;
  }
  const stats = {
    sheet: parsed.sheetName,
    created,
    changed,
    unchanged,
    fechaCorte: input.fechaCorte ?? null,
    people: new Set(parsed.rows.map((r) => r.nIde)).size,
    warnings: parsed.warnings.length,
  };
  const status = errors.length === 0 ? 'LISTO' : 'OBSERVADO';
  const [batch] = await db
    .insert(importBatches)
    .values({
      type: PROG_VAC_TYPE,
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
  if (status === 'LISTO' && parsed.rows.length > 0) {
    await db.insert(importBatchRows).values(
      parsed.rows.map((r) => ({
        batchId: batch.id,
        rowNumber: r.rowNumber,
        data: { ...r, fechaCorte: input.fechaCorte ?? null } satisfies StoredRow,
      })),
    );
  }
  await audit(db, actorId, 'IMPORT_UPLOAD', batch.id, status);
  return {
    id: batch.id,
    type: PROG_VAC_TYPE,
    status,
    rowCount: parsed.rows.length,
    errorCount: errors.length,
    stats,
  };
}

/** Aplica el lote en una transacción: crea períodos y corrige los existentes con ajuste versionado. */
export async function applyProgVacBatch(
  db: Db,
  actorId: string,
  batchId: string,
): Promise<BatchSummary> {
  const [head] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!head) throw new ImportError('NOT_FOUND');
  if (head.status !== 'LISTO') throw new ImportError('NOT_READY');
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('import:PROG_VAC'))`);
      const claimed = await tx
        .update(importBatches)
        .set({ status: 'APLICANDO' })
        .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')))
        .returning({ id: importBatches.id });
      if (claimed.length === 0) throw new ImportError('NOT_READY');
      const rows = (
        await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId))
      ).map((s) => s.data as StoredRow);
      let touched = 0;
      for (const row of rows) {
        const [cur] = await tx
          .select()
          .from(progVac)
          .where(
            and(
              eq(progVac.nIde, row.nIde),
              eq(progVac.nCont, row.nCont),
              eq(progVac.perIni, row.perIni),
              eq(progVac.perFin, row.perFin),
              eq(progVac.active, true),
            ),
          );
        if (!cur) {
          await tx.insert(progVac).values({
            nIde: row.nIde,
            nCont: row.nCont,
            perIni: row.perIni,
            perFin: row.perFin,
            dias: row.dias,
            disp: row.disp,
            estOrigen: row.estOrigen,
            estado: internalState(row.disp),
            fechaCorte: row.fechaCorte,
            source: 'IMPORT',
            createdBy: actorId,
          });
        } else {
          const version = cur.version + 1;
          if (cur.dias !== row.dias || cur.disp !== row.disp)
            await tx.insert(progVacAdjustments).values({
              progVacId: cur.id,
              actorAccountId: actorId,
              version,
              oldDias: cur.dias,
              newDias: row.dias,
              oldDisp: cur.disp,
              newDisp: row.disp,
              reason: `Carga Excel (lote ${batchId})${row.fechaCorte ? `, fecha de corte ${row.fechaCorte}` : ''}`,
            });
          await tx
            .update(progVac)
            .set({
              dias: row.dias,
              disp: row.disp,
              estOrigen: row.estOrigen,
              estado: internalState(row.disp),
              fechaCorte: row.fechaCorte,
              version,
              source: 'IMPORT',
              updatedAt: new Date(),
            })
            .where(eq(progVac.id, cur.id));
        }
        touched++;
      }
      if (touched !== head.rowCount || rows.length !== head.rowCount)
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
