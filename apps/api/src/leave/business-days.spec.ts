import { describe, expect, it } from 'vitest';
import {
  LeaveCalcError,
  computeLeave,
  isBusinessDay,
  isValidIsoDate,
  yearsNeeded,
} from './business-days';

const none = new Set<string>();

describe('computeLeave', () => {
  it('un día hábil: DIAS_DIS es 0 aunque se apruebe un día', () => {
    const r = computeLeave('2026-03-04', 1, none); // miércoles
    expect(r).toMatchObject({ start: '2026-03-04', end: '2026-03-04', calendarDiff: 0 });
    expect(r.businessDays).toBe(1);
    expect(r.returnDate).toBe('2026-03-05');
  });

  it('cinco días desde el lunes terminan el viernes y retornan el lunes', () => {
    const r = computeLeave('2026-03-02', 5, none);
    expect(r.end).toBe('2026-03-06');
    expect(r.calendarDiff).toBe(4);
    expect(r.returnDate).toBe('2026-03-09');
  });

  it('los fines de semana intermedios extienden el intervalo sin consumir días', () => {
    const r = computeLeave('2026-03-05', 5, none); // jueves
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
    const r = computeLeave('2026-03-02', 3, new Set(['2026-03-03']));
    expect(r.countedDays).toEqual(['2026-03-02', '2026-03-04', '2026-03-05']);
    expect(r.holidaysInRange).toEqual(['2026-03-03']);
  });

  it('el retorno salta fin de semana y festivos consecutivos', () => {
    const r = computeLeave('2026-03-06', 1, new Set(['2026-03-09', '2026-03-10']));
    expect(r.end).toBe('2026-03-06');
    expect(r.returnDate).toBe('2026-03-11');
  });

  it('cruza de año', () => {
    const r = computeLeave('2026-12-28', 5, new Set(['2026-12-31', '2027-01-01']));
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
    expect(code(() => computeLeave('2026-03-07', 1, none))).toBe('START_NOT_BUSINESS_DAY');
    expect(code(() => computeLeave('2026-03-03', 1, new Set(['2026-03-03'])))).toBe(
      'START_NOT_BUSINESS_DAY',
    );
    expect(code(() => computeLeave('2026-03-02', 0, none))).toBe('INVALID_DAYS');
    expect(code(() => computeLeave('2026-03-02', 1.5, none))).toBe('INVALID_DAYS');
    expect(code(() => computeLeave('2026-02-30', 1, none))).toBe('INVALID_DATE');
  });
});

describe('utilidades', () => {
  it('valida fechas ISO', () => {
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2027-02-29')).toBe(false);
    expect(isValidIsoDate('29/02/2028')).toBe(false);
  });
  it('isBusinessDay', () => {
    expect(isBusinessDay('2026-03-06', none)).toBe(true);
    expect(isBusinessDay('2026-03-07', none)).toBe(false);
  });
  it('yearsNeeded cubre el cruce de año', () => {
    expect(yearsNeeded('2026-12-20', 15)).toEqual([2026, 2027]);
    expect(yearsNeeded('2026-03-02', 5)).toEqual([2026]);
  });
});
