import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, roleAssignments } from '../db/schema';
import { createSubstitution } from '../leave/substitutions.service';
import { activeCompaniesForRole, hasActiveRole } from './roles';

const url = process.env.DATABASE_URL;

/** 21:00 del viernes 2 de octubre de 2026 en Colombia = 02:00 UTC del sábado 3. */
const NOCHE = new Date('2026-10-03T02:00:00Z');
/** 00:00 del sábado 3 de octubre en Colombia = 05:00 UTC. */
const MEDIANOCHE = new Date('2026-10-03T05:00:00Z');

describe.skipIf(!url)('las vigencias se cuentan por el día de Colombia, no por el de UTC', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let id = '';

  beforeAll(async () => {
    await runMigrations(url ?? '');
  });
  afterAll(async () => {
    await ctx.pool.end();
  });
  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, approval_substitutions, role_assignments, accounts CASCADE`,
    );
    const [a] = await db
      .insert(accounts)
      .values({ nIde: '100', email: 'a@x.co', passwordHash: 'x', status: 'ACTIVA' })
      .returning({ id: accounts.id });
    id = a?.id ?? '';
    // Solo se simula la fecha: los temporizadores y la red siguen reales.
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const role = (validFrom: string, validTo: string | null) =>
    db.insert(roleAssignments).values({
      accountId: id,
      role: 'VACATION_FINAL_APPROVER',
      companyCode: 'GA',
      validFrom,
      validTo,
    });

  it('un rol que vence hoy sigue vigente toda la noche, y deja de serlo a la medianoche de Colombia', async () => {
    await role('2020-01-01', '2026-10-02');
    vi.setSystemTime(NOCHE); // en UTC ya es 3 de octubre
    expect(await hasActiveRole(db, id, ['VACATION_FINAL_APPROVER'])).toBe(true);
    expect(await activeCompaniesForRole(db, id, 'VACATION_FINAL_APPROVER')).toEqual(['GA']);
    vi.setSystemTime(MEDIANOCHE);
    expect(await hasActiveRole(db, id, ['VACATION_FINAL_APPROVER'])).toBe(false);
    expect(await activeCompaniesForRole(db, id, 'VACATION_FINAL_APPROVER')).toEqual([]);
  });

  it('un rol que empieza mañana todavía no está vigente esta noche', async () => {
    await role('2026-10-03', null);
    vi.setSystemTime(NOCHE);
    expect(await hasActiveRole(db, id, ['VACATION_FINAL_APPROVER'])).toBe(false);
    vi.setSystemTime(MEDIANOCHE);
    expect(await hasActiveRole(db, id, ['VACATION_FINAL_APPROVER'])).toBe(true);
  });

  it('una suplencia puede empezar hoy aunque en UTC ya sea mañana, pero no ayer', async () => {
    await db.insert(roleAssignments).values({
      accountId: id,
      role: 'AREA_MANAGER',
      companyCode: 'GA',
      areaCode: 'A1',
      validFrom: '2020-01-01',
    });
    const [other] = await db
      .insert(accounts)
      .values({ nIde: '200', email: 'b@x.co', passwordHash: 'x', status: 'ACTIVA' })
      .returning({ id: accounts.id });
    vi.setSystemTime(NOCHE);
    const attempt = async (validFrom: string) =>
      createSubstitution(db, id, {
        substituteAccountId: other?.id ?? '',
        validFrom,
        validTo: '2026-10-09',
      }).then(
        () => 'OK',
        (e: { code?: string }) => e.code,
      );
    expect(await attempt('2026-10-01')).toBe('PAST_START'); // ayer en Colombia
    // hoy en Colombia: pasa la regla de la fecha (la rechaza otra, p. ej. que el suplente no sea elegible)
    expect(await attempt('2026-10-02')).not.toBe('PAST_START');
    expect(await db.select().from(accounts).where(eq(accounts.id, id))).toHaveLength(1);
  });
});
