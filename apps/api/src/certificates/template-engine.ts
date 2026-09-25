/**
 * Motor de plantillas del certificado laboral (SSD 6.1.1). Solo sustituye variables de una lista
 * blanca escritas como {{NOMBRE}}: sin expresiones, consultas ni HTML. El contenido es texto plano.
 */

export const VARIABLES = {
  N_IDE: 'Identificación del empleado',
  NOMBRE: 'Nombre completo',
  N_CONT: 'Número de contrato',
  F_INI: 'Fecha de inicio del contrato, en español',
  C_CAR: 'Código del cargo',
  CARGO: 'Nombre del cargo (catálogo)',
  C_COS: 'Código del centro de costo',
  CCOSTO: 'Nombre del centro de costo (catálogo)',
  C_AREA: 'Código del área',
  AREA: 'Nombre del área (catálogo)',
  TIPO_CONTRATO: 'Tipo de contrato (catálogo)',
  S_ACT: 'Salario actual en números (solo si la plantilla lo incluye)',
  S_ACT_LETRAS: 'Salario actual en letras',
  EMPRESA_NOMBRE: 'Razón social',
  EMPRESA_SIGLA: 'Sigla de la empresa',
  EMPRESA_DIRECCION: 'Dirección de la empresa',
  CIUDAD_EMISION: 'Ciudad de emisión (configuración)',
  FECHA_EMISION: 'Fecha de emisión, en español',
  DESTINATARIO: 'A quien se dirige (solo certificado dirigido)',
  FIRMANTE_NOMBRE: 'Nombre de quien firma (configuración)',
  FIRMANTE_CARGO: 'Cargo de quien firma (configuración)',
} as const;

export type VariableName = keyof typeof VARIABLES;
export type CertKind = 'GENERAL' | 'DIRIGIDO';

export const MAX_BODY = 4000;
export const MAX_TITLE = 120;
const VAR_RE = /\{\{\s*([A-Z_]+)\s*\}\}/g;
const BRACES_RE = /\{\{|\}\}/g;

export function extractVariables(body: string): string[] {
  return [...new Set([...body.matchAll(VAR_RE)].map((m) => m[1] as string))];
}

/** Errores de una plantilla: variables desconocidas, llaves sueltas y reglas de cada modalidad. */
export function validateTemplate(kind: CertKind, title: string, body: string): string[] {
  const problems: string[] = [];
  if (!title.trim() || title.length > MAX_TITLE)
    problems.push('El título es obligatorio (máximo 120 caracteres).');
  if (!body.trim() || body.length > MAX_BODY)
    problems.push('El texto es obligatorio (máximo 4000 caracteres).');
  const vars = extractVariables(body);
  const unknown = vars.filter((v) => !(v in VARIABLES));
  if (unknown.length > 0)
    problems.push(`Variables desconocidas: ${unknown.map((v) => `{{${v}}}`).join(', ')}.`);
  const stripped = body.replace(VAR_RE, '');
  if (BRACES_RE.test(stripped))
    problems.push('Hay llaves {{ }} que no forman una variable válida.');
  if (kind === 'DIRIGIDO' && !vars.includes('DESTINATARIO'))
    problems.push('El certificado dirigido debe incluir {{DESTINATARIO}}.');
  if (kind === 'GENERAL' && vars.includes('DESTINATARIO'))
    problems.push('El certificado general no puede incluir {{DESTINATARIO}}.');
  if (vars.includes('S_ACT_LETRAS') && !vars.includes('S_ACT'))
    problems.push('El salario en letras debe ir junto al salario en números ({{S_ACT}}).');
  return problems;
}

export class MissingDataError extends Error {
  constructor(readonly fields: string[]) {
    super('MISSING_DATA');
  }
}

const clean = (v: string) =>
  Array.from(v, (c) => (c.charCodeAt(0) < 32 && c !== '\n' ? ' ' : c))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();

/**
 * Sustituye las variables. Si falta un dato que la plantilla usa, lanza MissingDataError: nunca deja
 * {{VARIABLE}} visible ni pone un texto inventado.
 */
export function renderTemplate(
  body: string,
  values: Partial<Record<VariableName, string | null>>,
): string {
  const missing: string[] = [];
  const text = body.replace(VAR_RE, (_m, name: string) => {
    const v = values[name as VariableName];
    if (v === undefined || v === null || clean(v) === '') {
      missing.push(name);
      return '';
    }
    return clean(v).slice(0, 300);
  });
  if (missing.length > 0) throw new MissingDataError([...new Set(missing)]);
  return text;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
/** «15 de marzo de 2024» a partir de AAAA-MM-DD, sin depender de la zona horaria. */
export function longDateEs(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} de ${MONTHS[m - 1]} de ${y}`;
}

export const formatCop = (amount: string): string => {
  const n = Number(amount);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString('es-CO')}` : amount;
};

const UNITS = [
  '',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const TENS = [
  '',
  '',
  '',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

function below1000(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h ? HUNDREDS[h] : '';
  let tail: string;
  if (r < 30) tail = UNITS[r] ?? '';
  else {
    const t = Math.floor(r / 10);
    const u = r % 10;
    tail = u ? `${TENS[t]} y ${UNITS[u]}` : (TENS[t] ?? '');
  }
  return [head, tail].filter(Boolean).join(' ');
}

/** Entero (0 a 999.999.999.999) en letras: 1500000 → «un millón quinientos mil». */
const apocope = (s: string) => s.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');

export function numberToSpanish(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999_999) throw new RangeError('fuera de rango');
  if (n === 0) return 'cero';
  const parts: string[] = [];
  const billions = Math.floor(n / 1_000_000_000);
  const millions = Math.floor((n % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (billions)
    parts.push(billions === 1 ? 'mil' : `${apocope(below1000(billions))} mil`, 'millones');
  if (millions)
    parts.push(millions === 1 ? 'un millón' : `${apocope(below1000(millions))} millones`);
  if (thousands) parts.push(thousands === 1 ? 'mil' : `${apocope(below1000(thousands))} mil`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export const salaryInWords = (amount: string): string => {
  const n = Math.round(Number(amount));
  return `${numberToSpanish(n)} pesos m/cte`;
};

export const DEFAULT_TEMPLATES: Record<CertKind, { title: string; body: string }> = {
  GENERAL: {
    title: 'CERTIFICADO LABORAL',
    body: 'HACE CONSTAR\n\nQue {{NOMBRE}}, identificado(a) con el documento No. {{N_IDE}}, se encuentra vinculado(a) a {{EMPRESA_NOMBRE}} mediante contrato {{TIPO_CONTRATO}} desde el {{F_INI}}, desempeñando el cargo de {{CARGO}} en el área {{AREA}}.\n\nLa presente certificación se expide por solicitud de la parte interesada, en {{CIUDAD_EMISION}}, el {{FECHA_EMISION}}.',
  },
  DIRIGIDO: {
    title: 'CERTIFICADO LABORAL',
    body: 'A {{DESTINATARIO}}\n\nHACE CONSTAR\n\nQue {{NOMBRE}}, identificado(a) con el documento No. {{N_IDE}}, se encuentra vinculado(a) a {{EMPRESA_NOMBRE}} mediante contrato {{TIPO_CONTRATO}} desde el {{F_INI}}, desempeñando el cargo de {{CARGO}} en el área {{AREA}}.\n\nLa presente certificación se expide por solicitud de la parte interesada y va dirigida a {{DESTINATARIO}}, en {{CIUDAD_EMISION}}, el {{FECHA_EMISION}}.',
  },
};
