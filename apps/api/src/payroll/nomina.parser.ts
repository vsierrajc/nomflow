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
  opts: { per: string; nLiq: number; sheet?: string | undefined; maxRows: number },
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
  for (const name of NOMINA_COLUMNS) {
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
      const { raw, problem } = readCell(excelRow.getCell(cols.get(name) ?? 0).value);
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
    } else if (per !== null && per !== opts.per) {
      errors.push(
        issue(r, 'PER', null, 'el período de la fila no coincide con el declarado para la carga'),
      );
      bad = true;
    }
    const nLiqText = text('N_LIQ', true);
    if (nLiqText !== null && nLiqText !== '1' && nLiqText !== '2') {
      errors.push(issue(r, 'N_LIQ', nLiqText, 'N_LIQ debe ser 1 o 2'));
      bad = true;
    } else if (nLiqText !== null && Number(nLiqText) !== opts.nLiq) {
      errors.push(
        issue(
          r,
          'N_LIQ',
          nLiqText,
          'la liquidación de la fila no coincide con la declarada para la carga',
        ),
      );
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
    const ded = amount('DED');
    const dev = amount('DEV');
    if (bad || !per || !nIde || !contrato || !cCon) continue;
    rows.push({
      rowNumber: r,
      per,
      nLiq: opts.nLiq,
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

export function validatePayrollRows(rows: PayrollRow[]): ImportIssue[] {
  const errors: ImportIssue[] = [];
  const salaryByVoucher = new Map<string, string>();
  for (const row of rows) {
    if (row.slrio === null) continue;
    const key = `${row.nIde}\u0000${row.contrato}`;
    const known = salaryByVoucher.get(key);
    if (known === undefined) salaryByVoucher.set(key, row.slrio);
    else if (known !== row.slrio) {
      errors.push({
        row: row.rowNumber,
        column: 'SLRIO',
        value: null,
        rule: 'valores distintos de SLRIO en un mismo volante: revisar el origen',
      });
    }
  }
  return errors;
}
