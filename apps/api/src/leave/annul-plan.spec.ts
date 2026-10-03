import { describe, expect, it } from 'vitest';
import { planReturn } from './annul-plan';

const old = { progVacId: 'a', perIni: '2024-01-01', days: 3 };
const recent = { progVacId: 'b', perIni: '2025-01-01', days: 2 };
// cinco días hábiles contados; hoy es el 3.º
const counted = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
const today = '2026-10-07';

describe('planReturn', () => {
  it('por omisión (hasta ayer) hoy todavía no cuenta como disfrutado', () => {
    const p = planReturn(counted, [recent, old], today, 'YESTERDAY');
    expect(p).toMatchObject({ cutoff: '2026-10-06', enjoyedDays: 2, returnedDays: 3 });
    // los 2 días disfrutados se cargan al período más antiguo; el resto vuelve
    expect(p.allocations.map((a) => [a.progVacId, a.returned])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('con «hasta hoy», hoy ya cuenta como disfrutado', () => {
    const p = planReturn(counted, [old, recent], today, 'TODAY');
    expect(p).toMatchObject({ cutoff: '2026-10-07', enjoyedDays: 3, returnedDays: 2 });
    expect(p.allocations.map((a) => [a.progVacId, a.returned])).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
  });

  it('un disfrute que no ha empezado lo devuelve todo, sea cual sea la opción', () => {
    for (const until of ['YESTERDAY', 'TODAY'] as const) {
      const p = planReturn(counted, [old, recent], '2026-09-30', until);
      expect(p).toMatchObject({ enjoyedDays: 0, returnedDays: 5 });
    }
  });

  it('lo disfrutado pasa al siguiente período cuando el más antiguo no alcanza', () => {
    const p = planReturn(counted, [old, recent], '2026-10-09', 'YESTERDAY'); // 4 disfrutados
    expect(p.enjoyedDays).toBe(4);
    expect(p.allocations.map((a) => [a.progVacId, a.returned])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('el último día con «hasta hoy» ya no deja nada por devolver', () => {
    const p = planReturn(counted, [old, recent], '2026-10-09', 'TODAY');
    expect(p).toMatchObject({ enjoyedDays: 5, returnedDays: 0 });
  });

  it('nunca cuenta más días disfrutados que los aprobados', () => {
    const p = planReturn(counted, [{ ...old, days: 2 }], '2026-12-01', 'TODAY');
    expect(p).toMatchObject({ enjoyedDays: 2, returnedDays: 0 });
  });
});
