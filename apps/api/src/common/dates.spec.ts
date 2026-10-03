import { describe, expect, it } from 'vitest';
import { dateBogota, todayBogota } from './dates';

describe('fechas de Colombia', () => {
  it('«hoy» es el día de Bogotá, no el de UTC (UTC-5)', () => {
    // 21:00 del 2 de octubre en Bogotá ya es 3 de octubre en UTC
    expect(todayBogota(new Date('2026-10-03T02:00:00Z'))).toBe('2026-10-02');
    expect(todayBogota(new Date('2026-10-03T04:59:59Z'))).toBe('2026-10-02');
    expect(todayBogota(new Date('2026-10-03T05:00:00Z'))).toBe('2026-10-03');
    expect(todayBogota(new Date('2026-10-03T12:00:00Z'))).toBe('2026-10-03');
  });

  it('dateBogota da el día de Colombia de cualquier instante (nombres de archivo)', () => {
    expect(dateBogota(new Date('2026-12-31T23:30:00-05:00'))).toBe('2026-12-31');
    // cruce de año: en UTC ya es 2027
    expect(dateBogota(new Date('2027-01-01T03:00:00Z'))).toBe('2026-12-31');
  });
});
