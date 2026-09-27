import ExcelJS from 'exceljs';
import { issue, readCell, type ImportIssue } from '../imports/employees.parser';

/** Formato entregado por Gestión Humana: CDGO_AREA, CDGO_EMPRSA, NMBRE_AREA, JEFE, DIRECTOR. */
export const AREA_APPROVERS_COLUMNS = [
  'CDGO_AREA',
  'CDGO_EMPRSA',
  'NMBRE_AREA',
  'JEFE',
  'DIRECTOR',
] as const;
/** JEFE y DIRECTOR pueden faltar del archivo por completo (área sin ninguno de los dos). */
const REQUIRED_COLUMNS = AREA_APPROVERS_COLUMNS.filter((c) => c !== 'JEFE' && c !== 'DIRECTOR');

export interface AreaApproverRow {
  rowNumber: number;
  cEmp: string;
  cArea: string;
  nombreArea: string;
  /** Cédula de la persona, o null si viene vacía o no es una cédula (por ejemplo un código de vacante). */
  jefe: string | null;
  director: string | null;
  /** El archivo traía JEFE = DIRECTOR: prevalece el jefe y el director se limpia explícitamente. */
  directorClearedSamePerson: boolean;
}

export interface AreaApproversParseResult {
  sheetName: string;
  rows: AreaApproverRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const NIDE_RE = /^\d{4,15}$/;
const MAX_TEXT = 200;

/** Una cédula válida; cualquier otro texto (código de vacante, sigla) se trata como sin asignar. */
function asNIde(raw: string): string | null {
  return NIDE_RE.test(raw) ? raw : null;
}

export async function parseAreaApproversWorkbook(
  buffer: Buffer,
  opts: { sheet?: string | undefined; maxRows: number },
): Promise<AreaApproversParseResult> {
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
  const known = new Set<string>(AREA_APPROVERS_COLUMNS);
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

  const rows: AreaApproverRow[] = [];
  const seen = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const excelRow = ws.getRow(r);
    const cells = new Map<string, ReturnType<typeof readCell>['raw']>();
    let empty = true;
    let bad = false;
    for (const name of AREA_APPROVERS_COLUMNS) {
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

    const text = (col: string, required: boolean): string | null => {
      const raw = cells.get(col) ?? null;
      if (raw === null) {
        if (required) {
          errors.push(issue(r, col, null, 'valor obligatorio vacío'));
          bad = true;
        }
        return null;
      }
      if (typeof raw === 'boolean' || raw instanceof Date) {
        errors.push(issue(r, col, null, 'tipo de dato inválido'));
        bad = true;
        return null;
      }
      const value = String(raw).trim();
      if (value.length > MAX_TEXT) {
        errors.push(issue(r, col, null, `texto de más de ${MAX_TEXT} caracteres`));
        bad = true;
        return null;
      }
      return value;
    };

    const cEmp = text('CDGO_EMPRSA', true);
    const cArea = text('CDGO_AREA', true);
    const nombreArea = text('NMBRE_AREA', true) ?? '';
    const jefeRaw = text('JEFE', false);
    const directorRaw = text('DIRECTOR', false);
    if (bad || !cEmp || !cArea) continue;

    const key = `${cEmp}\u0000${cArea}`;
    if (seen.has(key)) {
      errors.push(issue(r, 'CDGO_AREA', cArea, 'área repetida en el archivo'));
      continue;
    }
    seen.add(key);

    const jefe = jefeRaw === null ? null : asNIde(jefeRaw);
    if (jefeRaw !== null && jefe === null)
      warnings.push(issue(r, 'JEFE', null, 'no es una cédula: el área queda sin jefe'));
    let director = directorRaw === null ? null : asNIde(directorRaw);
    if (directorRaw !== null && director === null)
      warnings.push(issue(r, 'DIRECTOR', null, 'no es una cédula: el área queda sin director'));

    let directorClearedSamePerson = false;
    if (jefe !== null && jefe === director) {
      // La misma persona no puede ser jefe y director de una misma área: prevalece el jefe.
      warnings.push(
        issue(r, 'DIRECTOR', null, 'igual al jefe: el área queda sin director asignado'),
      );
      director = null;
      directorClearedSamePerson = true;
    }

    rows.push({
      rowNumber: r,
      cEmp,
      cArea,
      nombreArea,
      jefe,
      director,
      directorClearedSamePerson,
    });
  }
  return { sheetName: ws.name, rows, errors, warnings };
}
