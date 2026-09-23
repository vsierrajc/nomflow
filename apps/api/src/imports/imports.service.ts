import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  auditLogs,
  employeeSnapshots,
  importBatchRows,
  importBatches,
} from '../db/schema';
import { revokeAllForAccount } from '../auth/session.service';
import {
  parseEmployeesWorkbook,
  validateEmployeeRows,
  type EmployeeRow,
  type ImportIssue,
} from './employees.parser';

export const MAX_STORED_ERRORS = 1000;
export const IMPORT_TYPE = 'EMPLEADOS';

export type ImportErrorCode =
  'NOT_XLSX' | 'DUPLICATE_FILE' | 'NOT_FOUND' | 'NOT_READY' | 'APPLY_FAILED';

export class ImportError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

export interface UploadInput {
  buffer: Buffer;
  fileName: string;
  sheet?: string | undefined;
  sourceSystem: string;
  responsible: string;
  maxRows: number;
}

export interface BatchSummary {
  id: string;
  status: string;
  rowCount: number;
  errorCount: number;
  stats: Record<string, unknown>;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
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

function dbValues(row: EmployeeRow, batchId: string) {
  return {
    importBatchId: batchId,
    nIde: row.nIde,
    nCont: row.nCont,
    email: row.email,
    est: row.est,
    cEmp: row.cEmp,
    nombre: row.nombre,
    cCos: row.cCos,
    cCosto: row.cCosto,
    sAct: row.sAct,
    cCar: row.cCar,
    cArea: row.cArea,
    fecNac: row.fecNac,
    cargo: row.cargo,
    area: row.area,
    hliq: row.hliq,
    sexo: row.sexo,
    fIni: row.fIni,
    turno: row.turno,
    nombres: row.nombres,
    apellidos: row.apellidos,
    celular: row.celular,
    profesion: row.profesion,
    nivelEducativo: row.nivelEducativo,
    tipoContrato: row.tipoContrato,
  };
}

const COMPARED = [
  'email',
  'est',
  'cEmp',
  'nombre',
  'cCos',
  'cCosto',
  'cCar',
  'cArea',
  'fecNac',
  'cargo',
  'area',
  'hliq',
  'sexo',
  'fIni',
  'turno',
  'nombres',
  'apellidos',
  'celular',
  'profesion',
  'nivelEducativo',
  'tipoContrato',
] as const;

type Tx = Pick<Db, 'select'>;

async function databaseConflicts(db: Tx, rows: EmployeeRow[]): Promise<ImportIssue[]> {
  const issues: ImportIssue[] = [];
  if (rows.length === 0) return issues;
  const ides = [...new Set(rows.map((r) => r.nIde))];
  const existing = await db
    .select()
    .from(employeeSnapshots)
    .where(inArray(employeeSnapshots.nIde, ides));
  const inFile = new Map(rows.map((r) => [`${r.nIde}\u0000${r.nCont}`, r]));

  for (const row of rows) {
    if (row.est !== 'V') continue;
    const other = existing.find(
      (e) =>
        e.nIde === row.nIde &&
        e.est === 'V' &&
        e.nCont !== row.nCont &&
        inFile.get(`${e.nIde}\u0000${e.nCont}`)?.est !== 'C',
    );
    if (other) {
      issues.push({
        row: row.rowNumber,
        column: 'N_CONT',
        value: null,
        rule: 'la base ya tiene otro contrato vigente de esta persona que el archivo no cancela',
      });
    }
  }
  const emails = [...new Set(rows.map((r) => r.email))];
  const owners = await db
    .select({ nIde: employeeSnapshots.nIde, email: employeeSnapshots.email })
    .from(employeeSnapshots)
    .where(inArray(employeeSnapshots.email, emails));
  for (const row of rows) {
    if (owners.some((o) => o.email === row.email && o.nIde !== row.nIde)) {
      issues.push({
        row: row.rowNumber,
        column: 'EMAIL',
        value: null,
        rule: 'el correo pertenece a otra persona en la base',
      });
    }
  }
  return issues;
}

export async function uploadEmployees(
  db: Db,
  actorId: string,
  input: UploadInput,
): Promise<BatchSummary> {
  if (!isZip(input.buffer)) throw new ImportError('NOT_XLSX');
  const fileHash = sha256(input.buffer);
  const [applied] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.type, IMPORT_TYPE),
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
    parsed = await parseEmployeesWorkbook(input.buffer, {
      sheet: input.sheet,
      maxRows: input.maxRows,
    });
  } catch {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'NOT_XLSX');
    throw new ImportError('NOT_XLSX');
  }

  const errors = [...parsed.errors, ...validateEmployeeRows(parsed.rows)];
  if (errors.length === 0) errors.push(...(await databaseConflicts(db, parsed.rows)));

  const ides = [...new Set(parsed.rows.map((r) => r.nIde))];
  const existing = ides.length
    ? await db.select().from(employeeSnapshots).where(inArray(employeeSnapshots.nIde, ides))
    : [];
  const existingByKey = new Map(existing.map((e) => [`${e.nIde}\u0000${e.nCont}`, e]));
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  let toCancel = 0;
  for (const row of parsed.rows) {
    const prev = existingByKey.get(`${row.nIde}\u0000${row.nCont}`);
    if (!prev) created++;
    else if (
      COMPARED.some((k) => (prev[k] ?? null) !== (row[k] ?? null)) ||
      (prev.sAct === null ? null : Number(prev.sAct)) !==
        (row.sAct === null ? null : Number(row.sAct))
    ) {
      changed++;
      if (prev.est === 'V' && row.est === 'C') toCancel++;
    } else unchanged++;
  }
  const keysInFile = new Set(parsed.rows.map((r) => `${r.nIde}\u0000${r.nCont}`));
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(employeeSnapshots);
  const missingInFile = Number(total) - [...keysInFile].filter((k) => existingByKey.has(k)).length;

  const stats = {
    sheet: parsed.sheetName,
    people: ides.length,
    active: parsed.rows.filter((r) => r.est === 'V').length,
    cancelled: parsed.rows.filter((r) => r.est === 'C').length,
    created,
    changed,
    unchanged,
    toCancel,
    missingInFile,
    warnings: parsed.warnings.length,
  };
  const status = errors.length === 0 ? 'LISTO' : 'OBSERVADO';

  const [batch] = await db
    .insert(importBatches)
    .values({
      type: IMPORT_TYPE,
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
    await db
      .insert(importBatchRows)
      .values(parsed.rows.map((r) => ({ batchId: batch.id, rowNumber: r.rowNumber, data: r })));
  }
  await audit(db, actorId, 'IMPORT_UPLOAD', batch.id, status);
  return { id: batch.id, status, rowCount: parsed.rows.length, errorCount: errors.length, stats };
}

export async function getBatch(
  db: Db,
  id: string,
): Promise<BatchSummary & { errors: ImportIssue[] }> {
  const [b] = await db.select().from(importBatches).where(eq(importBatches.id, id));
  if (!b) throw new ImportError('NOT_FOUND');
  return {
    id: b.id,
    status: b.status,
    rowCount: b.rowCount,
    errorCount: b.errorCount,
    stats: b.stats as Record<string, unknown>,
    errors: b.errors as ImportIssue[],
  };
}

export async function applyEmployeesBatch(
  db: Db,
  actorId: string,
  batchId: string,
): Promise<BatchSummary> {
  const [head] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!head) throw new ImportError('NOT_FOUND');
  if (head.status !== 'LISTO') throw new ImportError('NOT_READY');

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('import:EMPLEADOS'))`);
      const claimed = await tx
        .update(importBatches)
        .set({ status: 'APLICANDO' })
        .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')))
        .returning({ id: importBatches.id });
      if (claimed.length === 0) throw new ImportError('NOT_READY');

      const staged = await tx
        .select()
        .from(importBatchRows)
        .where(eq(importBatchRows.batchId, batchId));
      const rows = staged
        .map((s) => s.data as EmployeeRow)
        .sort((a, b) => (a.est === b.est ? a.rowNumber - b.rowNumber : a.est === 'C' ? -1 : 1));
      const conflicts = await databaseConflicts(tx, rows);
      if (conflicts.length > 0) throw new ImportError('APPLY_FAILED');

      for (const row of rows) {
        const values = dbValues(row, batchId);
        await tx
          .insert(employeeSnapshots)
          .values(values)
          .onConflictDoUpdate({
            target: [employeeSnapshots.nIde, employeeSnapshots.nCont],
            set: values,
          });
      }
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(employeeSnapshots)
        .where(eq(employeeSnapshots.importBatchId, batchId));
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
    if (e instanceof ImportError) throw e;
    throw e;
  }

  const cancelled = await db
    .select({ nIde: employeeSnapshots.nIde })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.importBatchId, batchId), eq(employeeSnapshots.est, 'C')));
  const ides = [...new Set(cancelled.map((c) => c.nIde))];
  let revoked = 0;
  for (const nIde of ides) {
    const [active] = await db
      .select({ id: employeeSnapshots.id })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, nIde), eq(employeeSnapshots.est, 'V')))
      .limit(1);
    if (active) continue;
    const accs = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.nIde, nIde));
    for (const a of accs) {
      await revokeAllForAccount(db, a.id);
      revoked++;
    }
  }
  await audit(
    db,
    actorId,
    'IMPORT_APPLY',
    batchId,
    revoked > 0 ? `SUCCESS_REVOKED_${revoked}` : 'SUCCESS',
  );
  return getBatch(db, batchId);
}
