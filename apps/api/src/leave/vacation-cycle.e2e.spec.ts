import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { employeeSnapshots, progVac } from '../db/schema';
import { addDays } from './business-days';
import { CYCLE_DAYS, cycleRange, dueCycles, runVacationCycles } from './vacation-cycle.service';

const url = process.env.DATABASE_URL;

describe('ciclos de vacaciones: cálculo puro', () => {
  it('un ciclo se cumple exactamente 360 días después del inicio', () => {
    expect(dueCycles('2024-01-01', addDays('2024-01-01', CYCLE_DAYS - 1))).toEqual([]);
    expect(dueCycles('2024-01-01', addDays('2024-01-01', CYCLE_DAYS))).toEqual([1]);
    expect(dueCycles('2024-01-01', addDays('2024-01-01', CYCLE_DAYS * 3))).toEqual([1, 2, 3]);
  });

  it('el ciclo N cubre desde el inicio hasta un día antes del siguiente', () => {
    expect(cycleRange('2024-01-01', 1)).toEqual({
      perIni: '2024-01-01',
      perFin: addDays('2024-01-01', CYCLE_DAYS - 1),
    });
    expect(cycleRange('2024-01-01', 2)).toEqual({
      perIni: addDays('2024-01-01', CYCLE_DAYS),
      perFin: addDays('2024-01-01', CYCLE_DAYS * 2 - 1),
    });
  });
});

describe.skipIf(!url)('generación automática de vacaciones por ciclo (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;

  beforeEach(async () => {
    await runMigrations(url ?? '');
    await db.execute(
      sql`TRUNCATE prog_vac_adjustments, prog_vac, audit_logs, employee_snapshots CASCADE`,
    );
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  async function employee(nIde: string, fIni: string, nCont = '1') {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont, email: `${nIde}@x.co`, est: 'V', nombre: nIde, fIni });
  }
  const periodsOf = (nIde: string) =>
    db
      .select()
      .from(progVac)
      .where(and(eq(progVac.nIde, nIde), eq(progVac.active, true)))
      .orderBy(progVac.perIni);

  it('crea el período del ciclo recién cumplido, con 15 días', async () => {
    const start = addDays(new Date().toISOString().slice(0, 10), -CYCLE_DAYS);
    await employee('100', start);
    const r = await runVacationCycles(db, new Date().toISOString().slice(0, 10));
    expect(r.created).toBe(1);
    const rows = await periodsOf('100');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      perIni: start,
      dias: 15,
      disp: 15,
      estado: 'ACTIVA',
      source: 'AUTOMATICO',
    });
  });

  it('no crea nada si el ciclo aún no se cumple, y no duplica si se corre dos veces', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await employee('200', addDays(today, -CYCLE_DAYS + 5));
    expect((await runVacationCycles(db, today)).created).toBe(0);
    expect(await periodsOf('200')).toHaveLength(0);

    await employee('300', addDays(today, -CYCLE_DAYS));
    await runVacationCycles(db, today);
    await runVacationCycles(db, today); // segunda corrida el mismo día: sin duplicar
    expect(await periodsOf('300')).toHaveLength(1);
  });

  it('con muchos ciclos atrasados, solo crea los 3 más recientes', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const start = addDays(today, -CYCLE_DAYS * 5); // 5 ciclos cumplidos, nunca cargados
    await employee('400', start);
    const r = await runVacationCycles(db, today);
    expect(r.created).toBe(3);
    const rows = await periodsOf('400');
    expect(rows).toHaveLength(3);
    // los tres más recientes: ciclos 3, 4 y 5
    expect(rows.map((p) => p.perIni)).toEqual([
      cycleRange(start, 3).perIni,
      cycleRange(start, 4).perIni,
      cycleRange(start, 5).perIni,
    ]);
  });

  it('al superar el tope de 3 acumulados, el más antiguo con días pasa a VENCIDA', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const start = addDays(today, -CYCLE_DAYS * 4);
    await employee('500', start);
    // simula 3 ciclos ya acumulados manualmente (ciclos 1, 2 y 3)
    for (let n = 1; n <= 3; n++) {
      const { perIni, perFin } = cycleRange(start, n);
      await db
        .insert(progVac)
        .values({ nIde: '500', nCont: '1', perIni, perFin, dias: 15, disp: 15 });
    }
    const r = await runVacationCycles(db, today); // se cumple el ciclo 4
    expect(r.created).toBe(1);
    expect(r.expired).toBe(1);
    const rows = await periodsOf('500');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ estado: 'VENCIDA', disp: 0 }); // el ciclo 1, el más antiguo
    expect(rows.slice(1).every((p) => p.estado === 'ACTIVA' && p.disp === 15)).toBe(true);
  });

  it('un período ya liquidado no cuenta para el tope de 3', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const start = addDays(today, -CYCLE_DAYS * 4);
    await employee('600', start);
    for (let n = 1; n <= 3; n++) {
      const { perIni, perFin } = cycleRange(start, n);
      const disp = n === 1 ? 0 : 15; // el ciclo 1 ya se disfrutó (LIQUIDADA)
      await db.insert(progVac).values({
        nIde: '600',
        nCont: '1',
        perIni,
        perFin,
        dias: 15,
        disp,
        estado: disp === 0 ? 'LIQUIDADA' : 'ACTIVA',
      });
    }
    const r = await runVacationCycles(db, today);
    expect(r.created).toBe(1);
    expect(r.expired).toBe(0); // hay solo 2 ACTIVA con días: el nuevo cabe sin vencer nada
    const rows = await periodsOf('600');
    expect(rows.filter((p) => p.estado === 'ACTIVA')).toHaveLength(3);
  });

  it('un contrato sin fecha de inicio o cancelado no genera nada', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '700', nCont: '1', email: '700@x.co', est: 'V', nombre: '700' }); // sin f_ini
    await employee('800', addDays(today, -CYCLE_DAYS));
    await db.update(employeeSnapshots).set({ est: 'C' }).where(eq(employeeSnapshots.nIde, '800'));
    const r = await runVacationCycles(db, today);
    expect(r.created).toBe(0);
  });
});
