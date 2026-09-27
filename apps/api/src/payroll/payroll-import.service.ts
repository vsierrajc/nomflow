import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLogs,
  employeeSnapshots,
  importBatchRows,
  importBatches,
  payrollLines,
  payrollVersions,
} from '../db/schema';
import {
  ImportError,
  MAX_STORED_ERRORS,
  getBatch,
  type BatchSummary,
} from '../imports/imports.service';
import { conceptUnits } from './concepts.service';
import { parseDecimal, toDecimalString } from './decimal';
import { countMixedSalary, parseNominaWorkbook, type PayrollRow } from './nomina.parser';

export const PAYROLL_TYPE = 'NOMINA';
const CHUNK = 500;

export interface PayrollUploadInput {
  buffer: Buffer;
  fileName: string;
  sheet?: string | undefined;
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

export function sumAmounts(rows: PayrollRow[]): { dev: bigint; ded: bigint } {
  let dev = 0n;
  let ded = 0n;
  for (const r of rows) {
    if (r.dev !== null) dev += parseDecimal(r.dev);
    if (r.ded !== null) ded += parseDecimal(r.ded);
  }
  return { dev, ded };
}

export function canonicalHash(rows: PayrollRow[]): string {
  const lines = rows
    .map((r) =>
      [
        r.per,
        r.nLiq,
        r.nIde,
        r.contrato,
        r.cCon,
        r.concepto ?? '',
        r.slrio ?? '',
        r.cant ?? '',
        r.ded ?? '',
        r.dev ?? '',
        r.tercero ?? '',
        r.nombre ?? '',
      ].join('\u001f'),
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function publishedVersion(db: Pick<Db, 'select'>, per: string, nLiq: number) {
  const [row] = await db
    .select()
    .from(payrollVersions)
    .where(
      and(
        eq(payrollVersions.per, per),
        eq(payrollVersions.nLiq, nLiq),
        eq(payrollVersions.status, 'PUBLICADA'),
      ),
    );
  return row ?? null;
}

const scopeKey = (per: string, nLiq: number) => `${per}|${nLiq}`;
const voucherKey = (nIde: string, contrato: string) => `${nIde}\u0000${contrato}`;

function groupByScope(rows: PayrollRow[]): Map<string, PayrollRow[]> {
  const groups = new Map<string, PayrollRow[]>();
  for (const r of rows) {
    const k = scopeKey(r.per, r.nLiq);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

/**
 * Carga de nómina: el período y la liquidación salen de las columnas PER y N_LIQ de cada fila, de modo que
 * un mismo archivo puede traer una o muchas liquidaciones. Cada volante (persona + contrato) que viene en
 * el archivo reemplaza al publicado; los demás volantes de esa liquidación se conservan.
 */
export async function uploadPayroll(
  db: Db,
  actorId: string,
  input: PayrollUploadInput,
): Promise<BatchSummary> {
  if (!isZip(input.buffer)) throw new ImportError('NOT_XLSX');

  const fileHash = createHash('sha256').update(input.buffer).digest('hex');
  const [applied] = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.type, PAYROLL_TYPE),
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
    parsed = await parseNominaWorkbook(input.buffer, {
      sheet: input.sheet,
      maxRows: input.maxRows,
    });
  } catch {
    await audit(db, actorId, 'IMPORT_UPLOAD', null, 'NOT_XLSX');
    throw new ImportError('NOT_XLSX');
  }

  const errors = [...parsed.errors];
  if (errors.length === 0 && parsed.rows.length === 0) {
    errors.push({
      row: 0,
      column: '',
      value: null,
      rule: 'el archivo no contiene filas de nómina',
    });
  }
  const hash = canonicalHash(parsed.rows);

  const totals = sumAmounts(parsed.rows);
  const people = [...new Set(parsed.rows.map((r) => r.nIde))];
  const scopes = groupByScope(parsed.rows);
  const pers = [...new Set(parsed.rows.map((r) => r.per))].sort();
  const vouchers = new Set(
    parsed.rows.map((r) => `${r.per}\u0000${r.nLiq}\u0000${voucherKey(r.nIde, r.contrato)}`),
  ).size;
  let republished = 0;
  if (scopes.size > 0) {
    const published = await db
      .select({ per: payrollVersions.per, nLiq: payrollVersions.nLiq })
      .from(payrollVersions)
      .where(and(eq(payrollVersions.status, 'PUBLICADA'), inArray(payrollVersions.per, pers)));
    republished = published.filter((v) => scopes.has(scopeKey(v.per, v.nLiq))).length;
  }
  const known = people.length
    ? await db
        .select({ nIde: employeeSnapshots.nIde })
        .from(employeeSnapshots)
        .where(inArray(employeeSnapshots.nIde, people))
    : [];
  const knownSet = new Set(known.map((k) => k.nIde));
  const codes = [...new Set(parsed.rows.map((r) => r.cCon))];
  const knownConcepts = await conceptUnits(db, codes);
  const unknownConcepts = codes.filter((c) => !knownConcepts.has(c)).length;
  const warnings = parsed.warnings.length;
  const stats = {
    sheet: parsed.sheetName,
    scopes: scopes.size,
    perFrom: pers[0] ?? '',
    perTo: pers.at(-1) ?? '',
    people: people.length,
    vouchers,
    totalDev: toDecimalString(totals.dev),
    totalDed: toDecimalString(totals.ded),
    net: toDecimalString(totals.dev - totals.ded),
    contentHash: hash,
    withoutEmployee: people.filter((p) => !knownSet.has(p)).length,
    unknownConcepts,
    mixedSalary: countMixedSalary(parsed.rows),
    warnings,
    republished,
  };
  const status = errors.length === 0 ? 'LISTO' : 'OBSERVADO';
  const [batch] = await db
    .insert(importBatches)
    .values({
      type: PAYROLL_TYPE,
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
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      await db
        .insert(importBatchRows)
        .values(
          parsed.rows
            .slice(i, i + CHUNK)
            .map((r) => ({ batchId: batch.id, rowNumber: r.rowNumber, data: r })),
        );
    }
  }
  await audit(db, actorId, 'IMPORT_UPLOAD', batch.id, status);
  return {
    id: batch.id,
    type: PAYROLL_TYPE,
    status,
    rowCount: parsed.rows.length,
    errorCount: errors.length,
    stats,
  };
}

export async function applyPayrollBatch(
  db: Db,
  actorId: string,
  batchId: string,
): Promise<BatchSummary> {
  const [head] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!head) throw new ImportError('NOT_FOUND');
  if (head.status !== 'LISTO') throw new ImportError('NOT_READY');
  const stats = head.stats as { totalDev: string; totalDed: string };

  try {
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(importBatches)
        .set({ status: 'APLICANDO' })
        .where(and(eq(importBatches.id, batchId), eq(importBatches.status, 'LISTO')))
        .returning({ id: importBatches.id });
      if (claimed.length === 0) throw new ImportError('NOT_READY');

      const rows = (
        await tx
          .select()
          .from(importBatchRows)
          .where(eq(importBatchRows.batchId, batchId))
          .orderBy(importBatchRows.rowNumber)
      ).map((s) => s.data as PayrollRow);
      const sums = sumAmounts(rows);
      if (
        rows.length !== head.rowCount ||
        toDecimalString(sums.dev) !== stats.totalDev ||
        toDecimalString(sums.ded) !== stats.totalDed
      ) {
        throw new ImportError('APPLY_FAILED');
      }

      // Las liquidaciones se bloquean y se procesan en orden fijo para que dos cargas no se crucen
      const scopes = [...groupByScope(rows).entries()].sort(([a], [b]) => a.localeCompare(b));
      let changed = 0;
      for (const [key, fileRows] of scopes) {
        const [per = '', nLiqText = '0'] = key.split('|');
        const nLiq = Number(nLiqText);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${per}:${nLiq}`}))`);
        if (await applyScope(tx, batchId, per, nLiq, fileRows)) changed++;
      }
      if (changed === 0) throw new ImportError('SAME_CONTENT');
      await tx
        .update(importBatches)
        .set({
          status: 'APLICADO',
          confirmedBy: actorId,
          appliedAt: new Date(),
          stats: {
            ...(head.stats as object),
            scopesPublished: changed,
            scopesUnchanged: scopes.length - changed,
          },
        })
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

/**
 * Publica una liquidación: los volantes que trae el archivo reemplazan a los publicados y los demás se
 * copian tal cual. Devuelve false si el resultado es idéntico a la versión vigente (no crea versión).
 */
async function applyScope(
  tx: Pick<Db, 'select' | 'insert' | 'update'>,
  batchId: string,
  per: string,
  nLiq: number,
  fileRows: PayrollRow[],
): Promise<boolean> {
  const current = await publishedVersion(tx, per, nLiq);
  const replaced = new Set(fileRows.map((r) => voucherKey(r.nIde, r.contrato)));
  const kept: PayrollRow[] = [];
  if (current) {
    const old = await tx
      .select()
      .from(payrollLines)
      .where(eq(payrollLines.versionId, current.id))
      .orderBy(payrollLines.rowIndex);
    for (const l of old) {
      if (replaced.has(voucherKey(l.nIde, l.contrato))) continue;
      const dec = (v: string | null) => (v === null ? null : toDecimalString(parseDecimal(v)));
      kept.push({
        rowNumber: l.rowIndex,
        per,
        nLiq,
        nIde: l.nIde,
        contrato: l.contrato,
        nombre: l.nombreOrigen,
        cCon: l.cCon,
        concepto: l.concepto,
        slrio: dec(l.slrio),
        cant: dec(l.cant),
        ded: dec(l.ded),
        dev: dec(l.dev),
        tercero: l.tercero,
      });
    }
  }
  const merged = [...kept, ...fileRows];
  const contentHash = canonicalHash(merged);
  if (current?.contentHash === contentHash) return false;
  const sums = sumAmounts(merged);
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${payrollVersions.version}), 0)::int + 1` })
    .from(payrollVersions)
    .where(and(eq(payrollVersions.per, per), eq(payrollVersions.nLiq, nLiq)));
  if (current) {
    await tx
      .update(payrollVersions)
      .set({ status: 'REEMPLAZADA' })
      .where(eq(payrollVersions.id, current.id));
  }
  const [version] = await tx
    .insert(payrollVersions)
    .values({
      per,
      nLiq,
      version: Number(next),
      status: 'PUBLICADA',
      contentHash,
      batchId,
      rowCount: merged.length,
      totalDev: toDecimalString(sums.dev),
      totalDed: toDecimalString(sums.ded),
    })
    .returning({ id: payrollVersions.id });
  if (!version) throw new Error('versión no creada');
  for (let i = 0; i < merged.length; i += CHUNK) {
    await tx.insert(payrollLines).values(
      merged.slice(i, i + CHUNK).map((r, k) => ({
        versionId: version.id,
        rowIndex: i + k,
        nIde: r.nIde,
        contrato: r.contrato,
        cCon: r.cCon,
        concepto: r.concepto,
        slrio: r.slrio,
        cant: r.cant,
        ded: r.ded,
        dev: r.dev,
        tercero: r.tercero,
        nombreOrigen: r.nombre,
      })),
    );
  }
  const [check] = await tx
    .select({
      n: sql<number>`count(*)::int`,
      dev: sql<string>`coalesce(sum(${payrollLines.dev}), 0)::text`,
      ded: sql<string>`coalesce(sum(${payrollLines.ded}), 0)::text`,
    })
    .from(payrollLines)
    .where(eq(payrollLines.versionId, version.id));
  if (
    !check ||
    Number(check.n) !== merged.length ||
    parseDecimal(check.dev) !== sums.dev ||
    parseDecimal(check.ded) !== sums.ded
  ) {
    throw new ImportError('APPLY_FAILED');
  }
  return true;
}

export async function listPayrollVersions(db: Db, per?: string) {
  return db
    .select({
      id: payrollVersions.id,
      per: payrollVersions.per,
      nLiq: payrollVersions.nLiq,
      version: payrollVersions.version,
      status: payrollVersions.status,
      rowCount: payrollVersions.rowCount,
      totalDev: payrollVersions.totalDev,
      totalDed: payrollVersions.totalDed,
      publishedAt: payrollVersions.publishedAt,
    })
    .from(payrollVersions)
    .where(per ? eq(payrollVersions.per, per) : undefined)
    .orderBy(payrollVersions.per, payrollVersions.nLiq, payrollVersions.version);
}
