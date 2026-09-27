import ExcelJS from 'exceljs';
import { issue, readCell, type ImportIssue, type Raw } from '../imports/employees.parser';
import { isDecimalText, parseDecimal, toDecimalString } from './decimal';

export const NOMINA_COLUMNS = [
  'PER',
  'N_LIQ',
  'N_IDE',
  'CONTRATO',
  'NOMBRE',
  'C_CON',
  'CONCEPTO',
  'SLRIO',
  'CANT',
  'DED',
  'DEV',
  'TERCERO',
] as const;

/** Columnas que el archivo debe traer; TERCERO es opcional (puede faltar o venir vacía). */
export const REQUIRED_COLUMNS = NOMINA_COLUMNS.filter((c) => c !== 'TERCERO');
/** Liquidaciones admitidas dentro de un período: 1 y 2 (quincenas) y de 3 a 9 (adicionales). */
export const MAX_N_LIQ = 9;

export interface PayrollRow {
  rowNumber: number;
  per: string;
  nLiq: number;
  nIde: string;
  contrato: string;
  nombre: string | null;
  cCon: string;
  concepto: string | null;
  slrio: string | null;
  cant: string | null;
  ded: string | null;
  dev: string | null;
  tercero: string | null;
}

export interface NominaParseResult {
  sheetName: string;
  rows: PayrollRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const PER_RE = /^\d{6}$/;
const MAX_TEXT = 300;

function validPer(per: string): boolean {
  if (!PER_RE.test(per)) return false;
  const month = Number(per.slice(4));
  return month >= 1 && month <= 12 && Number(per.slice(0, 4)) >= 2000;
}

export { validPer };

export async function parseNominaWorkbook(
  buffer: Buffer,
  opts: { sheet?: string | undefined; maxRows: number },
): Promise<NominaParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  if (!ws) {
    errors.push({ row: 0, column: '', value: null, rule: 'hoja no encontrada' });
    return { sheetName: opts.sheet ?? '', rows: [], errors, warnings };
  }

  const cols = new Map<string, number>();
  const known = new Set<string>(NOMINA_COLUMNS);
  const header = ws.getRow(1);
  for (let c = 1; c <= header.cellCount; c++) {
    const { raw } = readCell(header.getCell(c).value);
    if (raw === null) continue;
    const name = String(raw).trim().toUpperCase();
    if (!known.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna no reconocida' });
    else if (cols.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna duplicada' });
    else cols.set(name, c);
  }
  for (const name of REQUIRED_COLUMNS) {
    if (!cols.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna obligatoria ausente' });
  }
  if (errors.length > 0) return { sheetName: ws.name, rows: [], errors, warnings };
  if (ws.rowCount - 1 > opts.maxRows) {
    errors.push({
      row: 0,
      column: '',
      value: null,
      rule: `excede el máximo de ${opts.maxRows} filas`,
    });
    return { sheetName: ws.name, rows: [], errors, warnings };
  }

  const rows: PayrollRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const excelRow = ws.getRow(r);
    const cells = new Map<string, Raw>();
    let empty = true;
    let bad = false;
    for (const name of NOMINA_COLUMNS) {
      const at = cols.get(name);
      if (at === undefined) {
        cells.set(name, null); // columna opcional que el archivo no trae
        continue;
      }
      const { raw, problem } = readCell(excelRow.getCell(at).value);
      if (problem) {
        errors.push(issue(r, name, null, problem));
        bad = true;
      }
      if (raw !== null) empty = false;
      cells.set(name, raw);
    }
    if (empty) continue;

    const text = (col: string, required: boolean, identifier = false): string | null => {
      const raw = cells.get(col) ?? null;
      if (raw === null) {
        if (required) {
          errors.push(issue(r, col, null, 'valor obligatorio vacío'));
          bad = true;
        }
        return null;
      }
      if (typeof raw === 'number') {
        if (!Number.isSafeInteger(raw)) {
          errors.push(issue(r, col, null, 'debe ser un entero sin fracción'));
          bad = true;
          return null;
        }
        if (identifier)
          warnings.push(
            issue(r, col, null, 'valor numérico: pueden haberse perdido ceros iniciales'),
          );
        return String(raw);
      }
      if (typeof raw === 'boolean' || raw instanceof Date) {
        errors.push(issue(r, col, null, 'tipo de dato inválido'));
        bad = true;
        return null;
      }
      if (raw.length > MAX_TEXT) {
        errors.push(issue(r, col, null, `texto de más de ${MAX_TEXT} caracteres`));
        bad = true;
        return null;
      }
      return raw;
    };

    const amount = (col: string, nonNegative = false): string | null => {
      const raw = cells.get(col) ?? null;
      if (raw === null) return null;
      const asText = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
      if (!isDecimalText(asText)) {
        errors.push(
          issue(
            r,
            col,
            null,
            'importe inválido (decimal, máx. 12 enteros y 6 decimales, sin notación científica)',
          ),
        );
        bad = true;
        return null;
      }
      if (nonNegative && asText.startsWith('-')) {
        errors.push(issue(r, col, null, 'no puede ser negativo'));
        bad = true;
        return null;
      }
      return toDecimalString(parseDecimal(asText));
    };

    const per = text('PER', true);
    if (per !== null && !validPer(per)) {
      errors.push(issue(r, 'PER', null, 'PER debe ser AAAAMM válido'));
      bad = true;
    }
    const nLiqText = text('N_LIQ', true);
    const nLiq = nLiqText === null ? NaN : Number(nLiqText);
    if (nLiqText !== null && !(Number.isInteger(nLiq) && nLiq >= 1 && nLiq <= MAX_N_LIQ)) {
      errors.push(issue(r, 'N_LIQ', nLiqText, `N_LIQ debe ser un entero de 1 a ${MAX_N_LIQ}`));
      bad = true;
    }

    const nIde = text('N_IDE', true, true);
    const contrato = text('CONTRATO', true, true);
    const cCon = text('C_CON', true, true);
    const nombre = text('NOMBRE', false);
    const concepto = text('CONCEPTO', false);
    const tercero = text('TERCERO', false);
    const slrio = amount('SLRIO', true);
    const cant = amount('CANT');
    let ded = amount('DED');
    let dev = amount('DEV');
    // El origen escribe 0 en el lado que no corresponde: un concepto es devengo o deducción, no ambos.
    // Un concepto en cero en los dos lados se conserva como devengo de 0.
    const isZero = (v: string | null) => v !== null && parseDecimal(v) === 0n;
    if (dev !== null && ded !== null) {
      if (isZero(ded)) ded = null;
      else if (isZero(dev)) dev = null;
    }
    if (bad || !per || !nIde || !contrato || !cCon || Number.isNaN(nLiq)) continue;
    rows.push({
      rowNumber: r,
      per,
      nLiq,
      nIde,
      contrato,
      nombre,
      cCon,
      concepto,
      slrio,
      cant,
      ded,
      dev,
      tercero,
    });
  }
  return { sheetName: ws.name, rows, errors, warnings };
}

/**
 * Volantes (período + liquidación + persona + contrato) cuyas filas traen más de un SLRIO. El salario
 * que se muestra en el volante es el mayor de ellos; el caso solo se advierte en la vista previa.
 */
export function countMixedSalary(rows: PayrollRow[]): number {
  const salaries = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.slrio === null) continue;
    const key = `${row.per}\u0000${row.nLiq}\u0000${row.nIde}\u0000${row.contrato}`;
    const set = salaries.get(key);
    if (set) set.add(row.slrio);
    else salaries.set(key, new Set([row.slrio]));
  }
  return [...salaries.values()].filter((v) => v.size > 1).length;
}
