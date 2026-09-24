import ExcelJS from 'exceljs';
import { issue, readCell, type ImportIssue } from '../imports/employees.parser';
import { UNIT_RE } from './units';

export const CONCEPT_COLUMNS = ['CONCEPTO', 'NOMCONCEPTO', 'UNIDAD'] as const;

export interface ConceptRow {
  rowNumber: number;
  code: string;
  name: string;
  unit: string;
}

export interface ConceptParseResult {
  sheetName: string;
  rows: ConceptRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const squash = (v: string) => v.replace(/\s+/g, ' ').trim();

export async function parseConceptsWorkbook(
  buffer: Buffer,
  opts: { sheet?: string | undefined; maxRows: number },
): Promise<ConceptParseResult> {
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
  const known = new Set<string>(CONCEPT_COLUMNS);
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
  for (const name of CONCEPT_COLUMNS) {
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

  const rows: ConceptRow[] = [];
  const byCode = new Map<string, ConceptRow>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const code = readCell(row.getCell(cols.get('CONCEPTO') ?? 0).value);
    const name = readCell(row.getCell(cols.get('NOMCONCEPTO') ?? 0).value);
    const unit = readCell(row.getCell(cols.get('UNIDAD') ?? 0).value);
    if (
      code.raw === null &&
      name.raw === null &&
      unit.raw === null &&
      !code.problem &&
      !name.problem &&
      !unit.problem
    )
      continue;

    let bad = false;
    for (const [col, cell] of [
      ['CONCEPTO', code],
      ['NOMCONCEPTO', name],
      ['UNIDAD', unit],
    ] as const) {
      if (cell.problem) {
        errors.push(issue(r, col, null, cell.problem));
        bad = true;
      }
    }
    if (bad) continue;
    if (typeof code.raw === 'number') {
      errors.push({
        row: r,
        column: 'CONCEPTO',
        value: null,
        rule: 'el código debe ser texto (los ceros iniciales se pierden en celdas numéricas)',
      });
      continue;
    }
    const codeText = typeof code.raw === 'string' ? code.raw : null;
    const nameText = typeof name.raw === 'string' ? squash(name.raw) : null;
    const unitText = typeof unit.raw === 'string' ? unit.raw.trim().toUpperCase() : null;
    if (!codeText || codeText.length > 30) {
      errors.push({
        row: r,
        column: 'CONCEPTO',
        value: null,
        rule: 'código vacío o de más de 30 caracteres',
      });
      continue;
    }
    if (!nameText || nameText.length > 200) {
      errors.push({
        row: r,
        column: 'NOMCONCEPTO',
        value: null,
        rule: 'descripción vacía o de más de 200 caracteres',
      });
      continue;
    }
    if (!unitText || !UNIT_RE.test(unitText)) {
      errors.push({
        row: r,
        column: 'UNIDAD',
        value: null,
        rule: 'unidad vacía o inválida (1 a 10 letras o dígitos)',
      });
      continue;
    }
    const prev = byCode.get(codeText);
    if (prev) {
      if (prev.name === nameText && prev.unit === unitText) {
        warnings.push({
          row: r,
          column: 'CONCEPTO',
          value: null,
          rule: 'fila repetida idéntica (se conserva una)',
        });
      } else {
        errors.push({
          row: r,
          column: 'CONCEPTO',
          value: null,
          rule: 'código repetido con datos distintos',
        });
      }
      continue;
    }
    const entry = { rowNumber: r, code: codeText, name: nameText, unit: unitText };
    byCode.set(codeText, entry);
    rows.push(entry);
  }
  return { sheetName: ws.name, rows, errors, warnings };
}
