import ExcelJS from 'exceljs';
import { issue, readCell, type ImportIssue } from './employees.parser';

export type CatalogKind = 'AREA' | 'CCOSTO' | 'CARGO' | 'TIPO_CONTRATO';

interface CatalogDef {
  codeCol: string;
  nameCol: string;
  optional: string[];
  global: boolean;
  numericCodeIsError: boolean;
}

export const CATALOGS: Record<CatalogKind, CatalogDef> = {
  AREA: {
    codeCol: 'C_ARE',
    nameCol: 'NOMAREA',
    optional: ['JEFE_AREA'],
    global: false,
    numericCodeIsError: false,
  },
  CCOSTO: {
    codeCol: 'C_COS',
    nameCol: 'CCOSTO',
    optional: [],
    global: false,
    numericCodeIsError: false,
  },
  CARGO: {
    codeCol: 'C_CAR',
    nameCol: 'CARGO',
    optional: [],
    global: false,
    numericCodeIsError: false,
  },
  TIPO_CONTRATO: {
    codeCol: 'TIPO_CONTRATO',
    nameCol: 'NOMCONTRATO',
    optional: [],
    global: true,
    numericCodeIsError: true,
  },
};

export const isCatalogKind = (v: string): v is CatalogKind => v in CATALOGS;

export interface CatalogRow {
  rowNumber: number;
  code: string;
  name: string;
}

export interface CatalogParseResult {
  sheetName: string;
  rows: CatalogRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const squash = (v: string) => v.replace(/\s+/g, ' ').trim();

export async function parseCatalogWorkbook(
  buffer: Buffer,
  kind: CatalogKind,
  opts: { sheet?: string | undefined; maxRows: number },
): Promise<CatalogParseResult> {
  const def = CATALOGS[kind];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  if (!ws) {
    errors.push({ row: 0, column: '', value: null, rule: 'hoja no encontrada' });
    return { sheetName: opts.sheet ?? '', rows: [], errors, warnings };
  }

  const allowed = new Set([def.codeCol, def.nameCol, ...def.optional]);
  const cols = new Map<string, number>();
  const header = ws.getRow(1);
  for (let c = 1; c <= header.cellCount; c++) {
    const { raw } = readCell(header.getCell(c).value);
    if (raw === null) continue;
    const name = String(raw).trim().toUpperCase();
    if (!allowed.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna no reconocida' });
    else if (cols.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna duplicada' });
    else cols.set(name, c);
  }
  for (const req of [def.codeCol, def.nameCol]) {
    if (!cols.has(req))
      errors.push({ row: 1, column: req, value: null, rule: 'columna obligatoria ausente' });
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

  const rows: CatalogRow[] = [];
  const byCode = new Map<string, CatalogRow>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const code = readCell(row.getCell(cols.get(def.codeCol) ?? 0).value);
    const name = readCell(row.getCell(cols.get(def.nameCol) ?? 0).value);
    if (code.raw === null && name.raw === null && !code.problem && !name.problem) continue;
    let bad = false;
    for (const [col, cell] of [
      [def.codeCol, code],
      [def.nameCol, name],
    ] as const) {
      if (cell.problem) {
        errors.push(issue(r, col, null, cell.problem));
        bad = true;
      }
    }
    if (bad) continue;

    let codeText: string | null = null;
    if (typeof code.raw === 'number') {
      if (def.numericCodeIsError || !Number.isSafeInteger(code.raw)) {
        errors.push({
          row: r,
          column: def.codeCol,
          value: null,
          rule: 'el código debe ser texto (los ceros iniciales se pierden en celdas numéricas)',
        });
        continue;
      }
      warnings.push({
        row: r,
        column: def.codeCol,
        value: null,
        rule: 'código numérico: pueden haberse perdido ceros iniciales',
      });
      codeText = String(code.raw);
    } else if (typeof code.raw === 'string') codeText = code.raw;
    const nameText = typeof name.raw === 'string' ? squash(name.raw) : null;

    if (!codeText || codeText.length > 30) {
      errors.push({
        row: r,
        column: def.codeCol,
        value: null,
        rule: 'código vacío o de más de 30 caracteres',
      });
      continue;
    }
    if (!nameText || nameText.length > 200) {
      errors.push({
        row: r,
        column: def.nameCol,
        value: null,
        rule: 'descripción vacía o de más de 200 caracteres',
      });
      continue;
    }

    const prev = byCode.get(codeText);
    if (prev) {
      if (prev.name === nameText) {
        warnings.push({
          row: r,
          column: def.codeCol,
          value: null,
          rule: 'fila repetida idéntica (se conserva una)',
        });
      } else {
        errors.push({
          row: r,
          column: def.codeCol,
          value: null,
          rule: 'código repetido con descripciones distintas',
        });
      }
      continue;
    }
    const entry = { rowNumber: r, code: codeText, name: nameText };
    byCode.set(codeText, entry);
    rows.push(entry);
  }
  return { sheetName: ws.name, rows, errors, warnings };
}
