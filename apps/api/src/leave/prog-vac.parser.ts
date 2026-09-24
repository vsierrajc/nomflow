import ExcelJS from 'exceljs';
import { issue, readCell, type ImportIssue } from '../imports/employees.parser';
import { isValidIsoDate } from './business-days';
import { MAX_DIAS } from './prog-vac.service';

export const PROG_VAC_COLUMNS = [
  'N_IDE',
  'N_CONT',
  'PER_INI',
  'PER_FIN',
  'DIAS',
  'DISP',
  'EST',
] as const;
const REQUIRED = new Set<string>(['N_IDE', 'N_CONT', 'PER_INI', 'PER_FIN', 'DIAS', 'DISP']);

export interface ProgVacRow {
  rowNumber: number;
  nIde: string;
  nCont: string;
  perIni: string;
  perFin: string;
  dias: number;
  disp: number;
  estOrigen: string | null;
}

export interface ProgVacParseResult {
  sheetName: string;
  rows: ProgVacRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** DD/MM/AAAA (texto de la muestra), AAAA-MM-DD o celda de fecha. */
function toIso(raw: string | number | boolean | Date | null): string | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? null
      : `${raw.getUTCFullYear()}-${pad(raw.getUTCMonth() + 1)}-${pad(raw.getUTCDate())}`;
  }
  if (typeof raw !== 'string') return null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  const iso =
    dmy?.[1] && dmy[2] && dmy[3] ? `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}` : raw;
  return isValidIsoDate(iso) ? iso : null;
}

export async function parseProgVacWorkbook(
  buffer: Buffer,
  opts: { sheet?: string | undefined; maxRows: number },
): Promise<ProgVacParseResult> {
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
  const known = new Set<string>(PROG_VAC_COLUMNS);
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
  for (const name of PROG_VAC_COLUMNS) {
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

  const rows: ProgVacRow[] = [];
  const byKey = new Map<string, ProgVacRow>();
  let numericKeys = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const excelRow = ws.getRow(r);
    const cells = new Map<string, ReturnType<typeof readCell>['raw']>();
    let empty = true;
    let bad = false;
    for (const name of PROG_VAC_COLUMNS) {
      const { raw, problem } = readCell(excelRow.getCell(cols.get(name) ?? 0).value);
      if (problem) {
        errors.push(issue(r, name, null, problem));
        bad = true;
      }
      if (raw !== null) empty = false;
      cells.set(name, raw);
    }
    if (empty && !bad) continue;
    if (bad) continue;
    const fail = (col: string, rule: string) => {
      errors.push({ row: r, column: col, value: null, rule });
      bad = true;
    };
    for (const col of REQUIRED)
      if ((cells.get(col) ?? null) === null) fail(col, 'valor obligatorio vacío');
    if (bad) continue;

    const key = (col: 'N_IDE' | 'N_CONT'): string | null => {
      const v = cells.get(col);
      if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) {
          fail(col, 'número no entero o no representable: se pudo perder información en Excel');
          return null;
        }
        numericKeys++;
        return String(v);
      }
      if (typeof v === 'string' && v.length <= 30) return v;
      fail(col, 'identificador vacío o de más de 30 caracteres');
      return null;
    };
    const nIde = key('N_IDE');
    const nCont = key('N_CONT');
    const perIni = toIso(cells.get('PER_INI') ?? null);
    const perFin = toIso(cells.get('PER_FIN') ?? null);
    if (!perIni) fail('PER_INI', 'fecha inválida (use DD/MM/AAAA)');
    if (!perFin) fail('PER_FIN', 'fecha inválida (use DD/MM/AAAA)');
    const num = (col: 'DIAS' | 'DISP'): number | null => {
      const v = cells.get(col);
      const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        fail(col, 'debe ser un entero no negativo');
        return null;
      }
      return n;
    };
    const dias = num('DIAS');
    const disp = num('DISP');
    if (bad || !nIde || !nCont || !perIni || !perFin || dias === null || disp === null) continue;
    if (perIni > perFin) {
      fail('PER_FIN', 'el fin del período es anterior al inicio');
      continue;
    }
    if (dias > MAX_DIAS || disp > dias) {
      fail('DISP', `debe cumplirse 0 <= DISP <= DIAS <= ${MAX_DIAS}`);
      continue;
    }
    const est = cells.get('EST');
    const entry: ProgVacRow = {
      rowNumber: r,
      nIde,
      nCont,
      perIni,
      perFin,
      dias,
      disp,
      estOrigen: est === null || est === undefined ? null : String(est).trim().slice(0, 30),
    };
    const k = `${nIde}|${nCont}|${perIni}|${perFin}`;
    const prev = byKey.get(k);
    if (prev) {
      if (prev.dias === dias && prev.disp === disp)
        warnings.push({
          row: r,
          column: 'N_IDE',
          value: null,
          rule: 'fila repetida idéntica (se conserva una)',
        });
      else
        errors.push({
          row: r,
          column: 'N_IDE',
          value: null,
          rule: 'período repetido con datos distintos',
        });
      continue;
    }
    byKey.set(k, entry);
    rows.push(entry);
  }
  if (numericKeys > 0)
    warnings.push({
      row: 0,
      column: 'N_IDE',
      value: null,
      rule: `${numericKeys} identificadores vienen como números: si tenían ceros iniciales ya se perdieron en el Excel; exporte N_IDE y N_CONT como texto`,
    });
  return { sheetName: ws.name, rows, errors, warnings };
}
