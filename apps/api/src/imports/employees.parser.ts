import ExcelJS from 'exceljs';

export const EMPLOYEE_COLUMNS = [
  'C_EMP',
  'N_IDE',
  'NOMBRE',
  'C_COS',
  'CCOSTO',
  'S_ACT',
  'N_CONT',
  'C_CAR',
  'C_AREA',
  'FEC_NAC',
  'CARGO',
  'AREA',
  'HLIQ',
  'SEXO',
  'F_INI',
  'TURNO',
  'EST',
  'EMAIL',
  'NOMBRES',
  'APELLIDOS',
  'CELULAR',
  'PROFESION',
  'NIVELEDUCATIVO',
  'TIPO_CONTRATO',
] as const;

const REQUIRED = new Set([
  'C_EMP',
  'N_IDE',
  'NOMBRE',
  'N_CONT',
  'C_AREA',
  'F_INI',
  'EST',
  'EMAIL',
  'TIPO_CONTRATO',
]);
const ECHO_VALUE = new Set([
  'EST',
  'TIPO_CONTRATO',
  'C_EMP',
  'C_COS',
  'C_CAR',
  'C_AREA',
  'SEXO',
  'TURNO',
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ImportIssue {
  row: number;
  column: string;
  value: string | null;
  rule: string;
}

export interface EmployeeRow {
  rowNumber: number;
  cEmp: string;
  nIde: string;
  nombre: string;
  cCos: string | null;
  cCosto: string | null;
  sAct: string | null;
  nCont: string;
  cCar: string | null;
  cArea: string;
  fecNac: string | null;
  cargo: string | null;
  area: string | null;
  hliq: string | null;
  sexo: string | null;
  fIni: string;
  turno: string | null;
  est: 'V' | 'C';
  email: string;
  nombres: string | null;
  apellidos: string | null;
  celular: string | null;
  profesion: string | null;
  nivelEducativo: string | null;
  tipoContrato: string;
}

export interface ParseResult {
  sheetName: string;
  rows: EmployeeRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export type Raw = string | number | boolean | Date | null;

export function issue(row: number, column: string, raw: Raw, rule: string): ImportIssue {
  return { row, column, value: ECHO_VALUE.has(column) && raw !== null ? String(raw) : null, rule };
}

export function readCell(value: ExcelJS.CellValue): { raw: Raw; problem?: string } {
  if (value === null || value === undefined) return { raw: null };
  if (typeof value === 'string') return { raw: value.trim() === '' ? null : value.trim() };
  if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
    return { raw: value };
  }
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value)
      return { raw: null, problem: 'fórmula no permitida' };
    if ('hyperlink' in value) return { raw: null, problem: 'enlace no permitido' };
    if ('error' in value) return { raw: null, problem: 'celda con error' };
    if ('richText' in value) {
      const t = value.richText
        .map((r) => r.text)
        .join('')
        .trim();
      return { raw: t === '' ? null : t };
    }
  }
  return { raw: null, problem: 'tipo de celda no soportado' };
}

const pad = (n: number) => String(n).padStart(2, '0');

function toIsoDate(raw: Raw): string | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return `${raw.getUTCFullYear()}-${pad(raw.getUTCMonth() + 1)}-${pad(raw.getUTCDate())}`;
  }
  if (typeof raw === 'string') {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return null;
    const [y, mo, d] = raw.includes('/') ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    const ok =
      date.getUTCFullYear() === Number(y) &&
      date.getUTCMonth() === Number(mo) - 1 &&
      date.getUTCDate() === Number(d);
    return ok ? `${y}-${mo}-${d}` : null;
  }
  return null;
}

export async function parseEmployeesWorkbook(
  buffer: Buffer,
  opts: { sheet?: string | undefined; maxRows: number },
): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  if (!ws) {
    return {
      sheetName: opts.sheet ?? '',
      rows: [],
      errors: [{ row: 0, column: '', value: null, rule: 'hoja no encontrada' }],
      warnings,
    };
  }

  const headerRow = ws.getRow(1);
  const colIndex = new Map<string, number>();
  const known = new Set<string>(EMPLOYEE_COLUMNS);
  for (let c = 1; c <= headerRow.cellCount; c++) {
    const { raw } = readCell(headerRow.getCell(c).value);
    if (raw === null) continue;
    const name = String(raw).trim().toUpperCase();
    if (!known.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna no reconocida' });
    else if (colIndex.has(name))
      errors.push({ row: 1, column: name, value: null, rule: 'columna duplicada' });
    else colIndex.set(name, c);
  }
  for (const name of EMPLOYEE_COLUMNS) {
    if (!colIndex.has(name))
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

  const rows: EmployeeRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const excelRow = ws.getRow(r);
    const cells = new Map<string, Raw>();
    let empty = true;
    let bad = false;
    for (const name of EMPLOYEE_COLUMNS) {
      const { raw, problem } = readCell(excelRow.getCell(colIndex.get(name) ?? 0).value);
      if (problem) {
        errors.push(issue(r, name, null, problem));
        bad = true;
      }
      if (raw !== null) empty = false;
      cells.set(name, raw);
    }
    if (empty) continue;

    const text = (col: string, required = REQUIRED.has(col)): string | null => {
      const raw = cells.get(col) ?? null;
      if (raw === null) {
        if (required) {
          errors.push(issue(r, col, null, 'valor obligatorio vacío'));
          bad = true;
        }
        return null;
      }
      if (typeof raw === 'number' && col === 'HLIQ' && Number.isFinite(raw)) return String(raw);
      if (typeof raw === 'number') {
        if (!Number.isSafeInteger(raw)) {
          errors.push(issue(r, col, raw, 'debe ser un entero sin fracción'));
          bad = true;
          return null;
        }
        warnings.push(issue(r, col, raw, 'valor numérico: pueden haberse perdido ceros iniciales'));
        return String(raw);
      }
      if (typeof raw === 'boolean' || raw instanceof Date) {
        errors.push(issue(r, col, null, 'tipo de dato inválido'));
        bad = true;
        return null;
      }
      return raw;
    };

    const date = (col: string): string | null => {
      const raw = cells.get(col) ?? null;
      if (raw === null) {
        if (REQUIRED.has(col)) {
          errors.push(issue(r, col, null, 'valor obligatorio vacío'));
          bad = true;
        }
        return null;
      }
      const iso = toIsoDate(raw);
      if (!iso) {
        errors.push(issue(r, col, null, 'fecha inválida'));
        bad = true;
      }
      return iso;
    };

    let sAct: string | null = null;
    const rawSalary = cells.get('S_ACT') ?? null;
    if (rawSalary !== null) {
      const asText =
        typeof rawSalary === 'number'
          ? String(rawSalary)
          : typeof rawSalary === 'string'
            ? rawSalary
            : '';
      if (!/^\d{1,12}(\.\d{1,6})?$/.test(asText)) {
        errors.push(issue(r, 'S_ACT', null, 'importe inválido (decimal >= 0, máx. 6 decimales)'));
        bad = true;
      } else sAct = asText;
    }

    const est = text('EST');
    if (est !== null && est !== 'V' && est !== 'C') {
      errors.push(issue(r, 'EST', est, 'EST debe ser V (vigente) o C (cancelado)'));
      bad = true;
    }
    const emailRaw = text('EMAIL');
    const email = emailRaw?.toLowerCase() ?? null;
    if (email !== null && (!EMAIL_RE.test(email) || email.length > 254)) {
      errors.push(issue(r, 'EMAIL', null, 'correo inválido'));
      bad = true;
    }

    const nIde = text('N_IDE');
    const nCont = text('N_CONT');
    const cEmp = text('C_EMP');
    const nombre = text('NOMBRE');
    const cArea = text('C_AREA');
    const tipoContrato = text('TIPO_CONTRATO');
    const fIni = date('F_INI');
    const fecNac = date('FEC_NAC');
    const optional = {
      cCos: text('C_COS'),
      cCosto: text('CCOSTO'),
      cCar: text('C_CAR'),
      cargo: text('CARGO'),
      area: text('AREA'),
      hliq: text('HLIQ'),
      sexo: text('SEXO'),
      turno: text('TURNO'),
      nombres: text('NOMBRES'),
      apellidos: text('APELLIDOS'),
      celular: text('CELULAR'),
      profesion: text('PROFESION'),
      nivelEducativo: text('NIVELEDUCATIVO'),
    };
    if (bad || !nIde || !nCont || !cEmp || !nombre || !cArea || !tipoContrato || !fIni || !email)
      continue;
    if (est !== 'V' && est !== 'C') continue;
    rows.push({
      rowNumber: r,
      cEmp,
      nIde,
      nombre,
      sAct,
      nCont,
      cArea,
      fecNac,
      fIni,
      est,
      email,
      tipoContrato,
      ...optional,
    });
  }
  return { sheetName: ws.name, rows, errors, warnings };
}

export function validateEmployeeRows(rows: EmployeeRow[]): ImportIssue[] {
  const errors: ImportIssue[] = [];
  const contracts = new Set<string>();
  const activeByPerson = new Map<string, number>();
  const emailByPerson = new Map<string, string>();
  const personByEmail = new Map<string, string>();

  for (const row of rows) {
    const key = `${row.nIde}\u0000${row.nCont}`;
    if (contracts.has(key))
      errors.push({
        row: row.rowNumber,
        column: 'N_CONT',
        value: null,
        rule: 'contrato duplicado para la misma persona',
      });
    contracts.add(key);

    const knownEmail = emailByPerson.get(row.nIde);
    if (knownEmail !== undefined && knownEmail !== row.email) {
      errors.push({
        row: row.rowNumber,
        column: 'EMAIL',
        value: null,
        rule: 'la misma persona tiene correos distintos',
      });
    }
    emailByPerson.set(row.nIde, knownEmail ?? row.email);

    const owner = personByEmail.get(row.email);
    if (owner !== undefined && owner !== row.nIde) {
      errors.push({
        row: row.rowNumber,
        column: 'EMAIL',
        value: null,
        rule: 'correo compartido por personas distintas',
      });
    }
    personByEmail.set(row.email, owner ?? row.nIde);

    if (row.est === 'V') {
      const n = (activeByPerson.get(row.nIde) ?? 0) + 1;
      activeByPerson.set(row.nIde, n);
      if (n > 1)
        errors.push({
          row: row.rowNumber,
          column: 'EST',
          value: 'V',
          rule: 'más de un contrato vigente para la misma persona',
        });
    }
  }
  return errors;
}
