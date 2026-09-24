/** Cálculo de disfrute de vacaciones (SSD 6.2). Fechas como texto ISO AAAA-MM-DD, sin zona horaria. */

const DAY_MS = 86_400_000;

const toUtc = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
};
const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number): string => fromUtc(toUtc(iso) + n * DAY_MS);
export const diffDays = (from: string, to: string): number =>
  Math.round((toUtc(to) - toUtc(from)) / DAY_MS);

export function isValidIsoDate(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && fromUtc(toUtc(iso)) === iso;
}

/** 0 = domingo … 6 = sábado. */
const weekday = (iso: string): number => new Date(toUtc(iso)).getUTCDay();

export function isBusinessDay(iso: string, holidays: ReadonlySet<string>): boolean {
  const w = weekday(iso);
  return w !== 0 && w !== 6 && !holidays.has(iso);
}

export type LeaveErrorCode = 'START_NOT_BUSINESS_DAY' | 'INVALID_DAYS' | 'INVALID_DATE';

export interface LeaveDates {
  /** FEC_INI_DIS */
  start: string;
  /** FEC_FIN_DIS: último día hábil contado */
  end: string;
  /** DIAS_DIS: diferencia literal en días calendario (fin - inicio, sin sumar uno) */
  calendarDiff: number;
  /** DIAS_HABILES aprobados, los que se descuentan de DISP */
  businessDays: number;
  /** FECHA_RETORNO: primer día hábil posterior a `end` */
  returnDate: string;
  /** Lista de días hábiles contados, se conserva en la revisión aprobada */
  countedDays: string[];
  /** Fechas festivas que caen dentro del intervalo o de la búsqueda del retorno */
  holidaysInRange: string[];
}

export class LeaveCalcError extends Error {
  constructor(readonly code: LeaveErrorCode) {
    super(code);
  }
}

/**
 * Desde `start` (inclusive, debe ser hábil) suma solo lunes a viernes no festivos hasta completar
 * `businessDays`. Sábados, domingos y festivos intermedios extienden el intervalo sin consumir días.
 */
export function computeLeave(
  start: string,
  businessDays: number,
  holidays: ReadonlySet<string>,
): LeaveDates {
  if (!isValidIsoDate(start)) throw new LeaveCalcError('INVALID_DATE');
  if (!Number.isInteger(businessDays) || businessDays < 1 || businessDays > 90)
    throw new LeaveCalcError('INVALID_DAYS');
  if (!isBusinessDay(start, holidays)) throw new LeaveCalcError('START_NOT_BUSINESS_DAY');

  const counted: string[] = [];
  const skippedHolidays: string[] = [];
  let cursor = start;
  while (counted.length < businessDays) {
    if (isBusinessDay(cursor, holidays)) counted.push(cursor);
    else if (holidays.has(cursor) && ![0, 6].includes(weekday(cursor)))
      skippedHolidays.push(cursor);
    if (counted.length < businessDays) cursor = addDays(cursor, 1);
  }
  const end = cursor;
  let ret = addDays(end, 1);
  while (!isBusinessDay(ret, holidays)) {
    if (holidays.has(ret) && ![0, 6].includes(weekday(ret))) skippedHolidays.push(ret);
    ret = addDays(ret, 1);
  }
  return {
    start,
    end,
    calendarDiff: diffDays(start, end),
    businessDays,
    returnDate: ret,
    countedDays: counted,
    holidaysInRange: skippedHolidays,
  };
}

/** Años que toca cubrir para el intervalo y la búsqueda del retorno (cruce de año incluido). */
export function yearsNeeded(start: string, businessDays: number): number[] {
  // Cota superior generosa: cada 5 hábiles caben 7 calendario, más una semana de holgura y retorno.
  const bound = addDays(start, Math.ceil(businessDays * 1.4) + 21);
  const first = Number(start.slice(0, 4));
  const last = Number(bound.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}
