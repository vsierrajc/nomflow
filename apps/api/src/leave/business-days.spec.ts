import { describe, expect, it } from 'vitest';
import {
  LeaveCalcError,
  computeLeave,
  isBusinessDay,
  isValidIsoDate,
  yearsNeeded,
} from './business-days';

const none = new Set<string>();
/** Lunes a viernes: el turno por omisión antes de este cambio. */
const MON_FRI = new Set([1, 2, 3, 4, 5]);
/** Lunes a sábado. */
const MON_SAT = new Set([1, 2, 3, 4, 5, 6]);
/** Martes a viernes. */
const TUE_FRI = new Set([2, 3, 4, 5]);

describe('computeLeave', () => {
  it('un día hábil: DIAS_DIS es 0 aunque se apruebe un día', () => {
    const r = computeLeave('2026-03-04', 1, none, MON_FRI); // miércoles
    expect(r).toMatchObject({ start: '2026-03-04', end: '2026-03-04', calendarDiff: 0 });
    expect(r.businessDays).toBe(1);
    expect(r.returnDate).toBe('2026-03-05');
  });

  it('cinco días desde el lunes terminan el viernes y retornan el lunes', () => {
    const r = computeLeave('2026-03-02', 5, none, MON_FRI);
    expect(r.end).toBe('2026-03-06');
    expect(r.calendarDiff).toBe(4);
    expect(r.returnDate).toBe('2026-03-09');
  });

  it('los fines de semana intermedios extienden el intervalo sin consumir días', () => {
    const r = computeLeave('2026-03-05', 5, none, MON_FRI); // jueves
    expect(r.countedDays).toEqual([
      '2026-03-05',
      '2026-03-06',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
    ]);
    expect(r.end).toBe('2026-03-11');
    expect(r.calendarDiff).toBe(6);
  });

  it('un festivo intermedio extiende el intervalo y se informa', () => {
    const r = computeLeave('2026-03-02', 3, new Set(['2026-03-03']), MON_FRI);
    expect(r.countedDays).toEqual(['2026-03-02', '2026-03-04', '2026-03-05']);
    expect(r.holidaysInRange).toEqual(['2026-03-03']);
  });

  it('el retorno salta fin de semana y festivos consecutivos', () => {
    const r = computeLeave('2026-03-06', 1, new Set(['2026-03-09', '2026-03-10']), MON_FRI);
    expect(r.end).toBe('2026-03-06');
    expect(r.returnDate).toBe('2026-03-11');
  });

  it('cruza de año', () => {
    const r = computeLeave('2026-12-28', 5, new Set(['2026-12-31', '2027-01-01']), MON_FRI);
    expect(r.countedDays).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2027-01-04',
      '2027-01-05',
    ]);
    expect(r.end).toBe('2027-01-05');
    expect(r.returnDate).toBe('2027-01-06');
  });

  it('rechaza inicio en fin de semana o festivo, días inválidos y fechas inexistentes', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as LeaveCalcError).code;
      }
      return null;
    };
    expect(code(() => computeLeave('2026-03-07', 1, none, MON_FRI))).toBe('START_NOT_BUSINESS_DAY');
    expect(code(() => computeLeave('2026-03-03', 1, new Set(['2026-03-03']), MON_FRI))).toBe(
      'START_NOT_BUSINESS_DAY',
    );
    expect(code(() => computeLeave('2026-03-02', 0, none, MON_FRI))).toBe('INVALID_DAYS');
    expect(code(() => computeLeave('2026-03-02', 1.5, none, MON_FRI))).toBe('INVALID_DAYS');
    expect(code(() => computeLeave('2026-02-30', 1, none, MON_FRI))).toBe('INVALID_DATE');
  });
});

describe('computeLeave según el turno', () => {
  it('turno con sábado laboral (02) cuenta el sábado como día hábil', () => {
    // 2026-03-02 es lunes; con MON_SAT, 6 días hábiles alcanzan el sábado.
    const r = computeLeave('2026-03-02', 6, none, MON_SAT);
    expect(r.countedDays).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
    ]);
    expect(r.end).toBe('2026-03-07');
    // El domingo no es laboral para este turno: el retorno cae el lunes siguiente.
    expect(r.returnDate).toBe('2026-03-09');
  });

  it('turno sin lunes laboral (03) rechaza empezar un lunes y salta los lunes intermedios', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as LeaveCalcError).code;
      }
      return null;
    };
    expect(code(() => computeLeave('2026-03-02', 1, none, TUE_FRI))).toBe('START_NOT_BUSINESS_DAY');
    // 2026-03-03 es martes; con TUE_FRI, 5 días hábiles saltan el lunes 09 sin contarlo.
    const r = computeLeave('2026-03-03', 5, none, TUE_FRI);
    expect(r.countedDays).toEqual([
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-10',
    ]);
    expect(r.holidaysInRange).toEqual([]);
  });

  it('un festivo en un día laboral del turno (sábado bajo el turno 02) sigue restando el día', () => {
    const r = computeLeave('2026-03-02', 6, new Set(['2026-03-07']), MON_SAT);
    expect(r.countedDays).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-09',
    ]);
    expect(r.holidaysInRange).toEqual(['2026-03-07']);
  });
});

describe('utilidades', () => {
  it('valida fechas ISO', () => {
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2027-02-29')).toBe(false);
    expect(isValidIsoDate('29/02/2028')).toBe(false);
  });
  it('isBusinessDay depende del turno', () => {
    expect(isBusinessDay('2026-03-06', none, MON_FRI)).toBe(true); // viernes
    expect(isBusinessDay('2026-03-07', none, MON_FRI)).toBe(false); // sábado
    expect(isBusinessDay('2026-03-07', none, MON_SAT)).toBe(true); // sábado, turno 02
    expect(isBusinessDay('2026-03-02', none, TUE_FRI)).toBe(false); // lunes, turno 03
  });
  it('yearsNeeded cubre el cruce de año', () => {
    expect(yearsNeeded('2026-12-20', 15)).toEqual([2026, 2027]);
    expect(yearsNeeded('2026-03-02', 5)).toEqual([2026]);
  });
});
