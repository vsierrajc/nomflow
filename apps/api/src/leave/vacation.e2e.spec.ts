import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  areaManagerAssignments,
  employeeSnapshots,
  holidayCalendars,
  holidays,
  progVac,
  progVacAdjustments,
  roleAssignments,
  vacaciones,
  vacationActions,
  vacationRequests,
} from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string; id: string };
type Role = (typeof roleAssignments.$inferInsert)['role'];

describe.skipIf(!url)('solicitud de vacaciones: flujo completo (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  let emp: Sess;
  let mgr: Sess;
  let fin: Sess;
  let adm: Sess;
  let p1 = '';
  let p2 = '';

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  async function login(email: string, id: string): Promise<Sess> {
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
      id,
    };
  }
  async function person(
    nIde: string,
    email: string,
    roles: { role: Role; area?: boolean }[] = [],
    cArea = '10300',
  ): Promise<Sess> {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email, est: 'V', nombre: `Persona ${nIde}`, cEmp: 'GA', cArea });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    for (const r of roles)
      await db.insert(roleAssignments).values({
        accountId: a?.id ?? '',
        role: r.role,
        validFrom: '2020-01-01',
        ...(r.area ? { companyCode: 'GA', areaCode: '10300' } : {}),
      });
    return login(email, a?.id ?? '');
  }
  const send = (s: Sess, method: 'post' | 'get', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'post' ? r.set('X-CSRF-Token', s.csrf).send(body ?? {}) : r;
  };
  async function calendar(year: number, days: string[], version = 1) {
    const [c] = await db
      .insert(holidayCalendars)
      .values({
        year,
        version,
        status: 'PUBLICADO',
        source: 'MANUAL',
        createdBy: adm.id,
        publishedBy: adm.id,
        publishedAt: new Date(),
      })
      .returning({ id: holidayCalendars.id });
    await db
      .insert(holidays)
      .values(days.map((d) => ({ calendarId: c?.id ?? '', date: d, name: 'Festivo' })));
    return c?.id ?? '';
  }
  const submit = (start: string, allocations: { progVacId: string; days: number }[], s = emp) =>
    send(s, 'post', '/me/vacations', { start, allocations });
  const status = async (id: string) =>
    (await db.select().from(vacationRequests).where(eq(vacationRequests.id, id)))[0]?.status;

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE vacaciones, vacation_actions, vacation_revision_allocations, vacation_revisions, vacation_requests, prog_vac_adjustments, prog_vac, holidays, holiday_calendars, area_manager_assignments, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    adm = await person('ADM', 'adm@x.co', [{ role: 'HR_ADMIN' }], '99999');
    emp = await person('100', 'e@x.co');
    mgr = await person('200', 'm@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    fin = await person('300', 'f@x.co', [{ role: 'VACATION_FINAL_APPROVER' }], '99999');
    await db.insert(areaManagerAssignments).values({
      cEmp: 'GA',
      cArea: '10300',
      managerAccountId: mgr.id,
      validFrom: '2020-01-01',
      createdBy: adm.id,
    });
    await calendar(2026, ['2026-03-23']);
    await calendar(2027, ['2027-01-01']);
    const [a, b] = await db
      .insert(progVac)
      .values([
        { nIde: '100', nCont: '1', perIni: '2025-01-01', perFin: '2025-12-31', dias: 15, disp: 10 },
        { nIde: '100', nCont: '1', perIni: '2024-01-01', perFin: '2024-12-31', dias: 15, disp: 5 },
      ])
      .returning({ id: progVac.id });
    p1 = a?.id ?? '';
    p2 =
      (
        await db
          .select()
          .from(progVac)
          .where(sql`${progVac.perIni} = '2024-01-01'`)
      )[0]?.id ?? '';
    void b;
  });

  it('camino completo: envía, el jefe aprueba, el aprobador final descuenta y crea VACACIONES', async () => {
    const created = await submit('2026-03-02', [
      { progVacId: p1, days: 3 },
      { progVacId: p2, days: 2 },
    ]).expect(201);
    const id = created.body.id as string;
    expect(await status(id)).toBe('PENDIENTE_JEFE');
    // pendiente: no consume días
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(10);

    const mine = await send(emp, 'get', '/me/vacations').expect(200);
    expect(mine.body[0]).toMatchObject({
      id,
      status: 'PENDIENTE_JEFE',
      start: '2026-03-02',
      end: '2026-03-06',
      calendarDiff: 4,
      businessDays: 5,
      returnDate: '2026-03-09',
    });
    const inbox = await send(mgr, 'get', '/approvals/vacations/manager').expect(200);
    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0].employee).toBe('Persona 100');

    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(409); // aún sin jefe
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(200);
    expect(await status(id)).toBe('PENDIENTE_FINAL');
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(200);
    expect(await status(id)).toBe('APROBADA');

    const periods = await db.select().from(progVac);
    expect(Object.fromEntries(periods.map((p) => [p.id, [p.disp, p.estado]]))).toEqual({
      [p1]: [7, 'ACTIVA'],
      [p2]: [3, 'ACTIVA'],
    });
    const [v] = await db.select().from(vacaciones);
    expect(v).toMatchObject({
      nIde: '100',
      nCont: '1',
      fecIniDis: '2026-03-02',
      fecFinDis: '2026-03-06',
      diasDis: 4,
      diasHabiles: 5,
      fechaRetorno: '2026-03-09',
    });
    expect(await db.select().from(progVacAdjustments)).toHaveLength(2);
    const acts = await db.select().from(vacationActions).orderBy(vacationActions.at);
    expect(acts.map((a) => a.action)).toEqual(['ENVIAR', 'APROBAR_JEFE', 'APROBAR_FINAL']);
    expect(new Set(acts.map((a) => a.contentHash)).size).toBe(1);
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(409); // ya aprobada
    const det = await send(emp, 'get', `/me/vacations/${id}`).expect(200);
    expect(det.body.revisions[0].allocations).toHaveLength(2);
  });

  it('solo se puede pedir de los períodos de PROG_VAC con días disponibles del propio contrato', async () => {
    const periods = async () =>
      (await send(emp, 'get', '/me/vacations/periods').expect(200)).body as { id: string }[];
    expect((await periods()).map((p) => p.id).sort()).toEqual([p1, p2].sort());

    // liquidado (DISP = 0): no se ofrece ni se acepta
    const [liq] = await db
      .insert(progVac)
      .values({
        nIde: '100',
        nCont: '1',
        perIni: '2023-01-01',
        perFin: '2023-12-31',
        dias: 15,
        disp: 0,
        estado: 'LIQUIDADA',
      })
      .returning({ id: progVac.id });
    // dado de baja
    const [off] = await db
      .insert(progVac)
      .values({
        nIde: '100',
        nCont: '1',
        perIni: '2022-01-01',
        perFin: '2022-12-31',
        dias: 15,
        disp: 5,
        active: false,
      })
      .returning({ id: progVac.id });
    // de otro contrato de la misma persona y de otra persona
    const [oc] = await db
      .insert(progVac)
      .values({
        nIde: '100',
        nCont: '2',
        perIni: '2021-01-01',
        perFin: '2021-12-31',
        dias: 15,
        disp: 5,
      })
      .returning({ id: progVac.id });
    await person('700', 'x7@x.co');
    const [ot] = await db
      .insert(progVac)
      .values({
        nIde: '700',
        nCont: '1',
        perIni: '2025-01-01',
        perFin: '2025-12-31',
        dias: 15,
        disp: 15,
      })
      .returning({ id: progVac.id });
    expect((await periods()).map((p) => p.id).sort()).toEqual([p1, p2].sort());

    const body = (id: string) => ({
      start: '2026-03-02',
      allocations: [{ progVacId: id, days: 1 }],
    });
    for (const path of ['/me/vacations/preview', '/me/vacations']) {
      const codes: [string, number, string?][] = [
        [liq?.id ?? '', 400, 'PERIOD_NOT_AVAILABLE'],
        [off?.id ?? '', 404],
        [oc?.id ?? '', 404],
        [ot?.id ?? '', 404],
        ['00000000-0000-4000-8000-000000000000', 404],
      ];
      for (const [id, status, code] of codes) {
        const res = await send(emp, 'post', path, body(id)).expect(status);
        if (code) expect(res.body.code, `${path} ${id}`).toBe(code);
      }
    }
    // mezclar un período válido con uno no disponible tampoco pasa
    await send(emp, 'post', '/me/vacations', {
      start: '2026-03-02',
      allocations: [
        { progVacId: p1, days: 1 },
        { progVacId: liq?.id ?? '', days: 1 },
      ],
    }).expect(400);
    expect(await db.select().from(vacationRequests)).toHaveLength(0);

    // el jefe tampoco puede proponer períodos no disponibles
    const ok = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${ok.body.id}/propose`, {
      start: '2026-03-02',
      allocations: [{ progVacId: liq?.id ?? '', days: 1 }],
      reason: 'Se prueba con un período liquidado',
    }).expect(400);
    await send(mgr, 'post', `/approvals/vacations/manager/${ok.body.id}/propose`, {
      start: '2026-03-02',
      allocations: [{ progVacId: ot?.id ?? '', days: 1 }],
      reason: 'Se prueba con un período ajeno',
    }).expect(404);
    expect(await status(ok.body.id)).toBe('PENDIENTE_JEFE');
  });

  it('validaciones al enviar: remanente, jefe, cruce de fechas y calendario', async () => {
    await submit('2026-03-02', [{ progVacId: p2, days: 6 }]).expect(400); // > DISP
    await submit('2026-03-07', [{ progVacId: p1, days: 1 }]).expect(400); // sábado
    await submit('2026-03-02', [
      { progVacId: p1, days: 1 },
      { progVacId: p1, days: 1 },
    ]).expect(400);
    await submit('2028-03-02', [{ progVacId: p1, days: 1 }]).expect(422); // sin calendario
    const ok = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    await submit('2026-03-04', [{ progVacId: p2, days: 2 }]).expect(409); // se cruza
    await submit('2026-03-09', [{ progVacId: p2, days: 2 }]).expect(201);
    await send(emp, 'post', `/me/vacations/${ok.body.id}/cancel`).expect(200);
    expect(await status(ok.body.id)).toBe('CANCELADA');
    await send(emp, 'post', `/me/vacations/${ok.body.id}/cancel`).expect(409);
    const other = await person('500', 'o@x.co', [], '10300');
    await submit('2026-03-02', [{ progVacId: p1, days: 1 }], other).expect(404); // período ajeno

    await db.delete(areaManagerAssignments);
    await submit('2026-06-01', [{ progVacId: p1, days: 1 }]).expect(422); // sin jefe vigente
  });

  it('el jefe rechaza con motivo o propone cambios que el empleado debe aceptar', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/reject`, {
      reason: 'corto',
    }).expect(400);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/reject`, {
      reason: 'Hay cierre contable esa semana',
    }).expect(200);
    expect(await status(a.body.id)).toBe('RECHAZADA');
    expect(await db.select().from(vacaciones)).toHaveLength(0);

    const b = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    const id = b.body.id as string;
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/propose`, {
      start: '2026-03-30',
      allocations: [{ progVacId: p1, days: 3 }],
      reason: 'x',
    }).expect(400);
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/propose`, {
      start: '2026-03-30',
      allocations: [{ progVacId: p1, days: 3 }],
      reason: 'Se reprograma por cierre de mes',
    }).expect(200);
    expect(await status(id)).toBe('REVISION_EMPLEADO');
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(409); // falta aceptación
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(409);
    await send(mgr, 'post', `/me/vacations/${id}/accept`).expect(404); // no es el dueño
    await send(emp, 'post', `/me/vacations/${id}/accept`).expect(200);
    expect(await status(id)).toBe('PENDIENTE_FINAL');
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(200);
    const [v] = await db.select().from(vacaciones);
    expect(v).toMatchObject({
      fecIniDis: '2026-03-30',
      fecFinDis: '2026-04-01',
      diasHabiles: 3,
      diasDis: 2,
      fechaRetorno: '2026-04-02',
    });
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(7);
    const det = await send(emp, 'get', `/me/vacations/${id}`).expect(200);
    expect(det.body.revisions).toHaveLength(2);
    expect(det.body.revisions[1].reason).toBe('Se reprograma por cierre de mes');
  });

  it('solo quien tiene el rol y la asignación puede aprobar; nadie firma su propia solicitud', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    const id = a.body.id as string;
    // administrador sin el rol específico
    await send(adm, 'get', '/approvals/vacations/manager').expect(403);
    await send(adm, 'post', `/approvals/vacations/final/${id}/approve`).expect(403);
    // empleado
    await send(emp, 'post', `/approvals/vacations/manager/${id}/approve`).expect(403);
    // otro jefe con el rol, pero sin la asignación
    const other = await person('600', 'o2@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    await send(other, 'post', `/approvals/vacations/manager/${id}/approve`).expect(404);
    // un tercero no ve el detalle
    await send(other, 'get', `/me/vacations/${id}`).expect(404);
    await send(emp, 'get', `/me/vacations/${id}`).expect(200);
    await send(mgr, 'get', `/me/vacations/${id}`).expect(200);
    // sin sesión
    await request(srv()).get('/me/vacations').expect(401);
    await request(srv()).post(`/approvals/vacations/final/${id}/approve`).expect(401);

    // el jefe pide sus propias vacaciones: no puede aprobarlas
    const [pm] = await db
      .insert(progVac)
      .values({
        nIde: '200',
        nCont: '1',
        perIni: '2025-01-01',
        perFin: '2025-12-31',
        dias: 15,
        disp: 15,
      })
      .returning({ id: progVac.id });
    const own = await submit('2026-05-04', [{ progVacId: pm?.id ?? '', days: 2 }], mgr).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${own.body.id}/approve`).expect(403);
  });

  it('dos aprobaciones concurrentes no consumen más que DISP', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p2, days: 4 }]).expect(201);
    const b = await submit('2026-03-16', [{ progVacId: p2, days: 4 }]).expect(201);
    for (const x of [a, b])
      await send(mgr, 'post', `/approvals/vacations/manager/${x.body.id}/approve`).expect(200);
    const res = await Promise.all([
      send(fin, 'post', `/approvals/vacations/final/${a.body.id}/approve`),
      send(fin, 'post', `/approvals/vacations/final/${b.body.id}/approve`),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.select().from(progVac).where(eq(progVac.id, p2)))[0]?.disp).toBe(1);
    expect(await db.select().from(vacaciones)).toHaveLength(1);
  });

  it('si el calendario cambia antes de la aprobación final, no se aprueba', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(200);
    // nueva versión publicada del año con un festivo dentro del intervalo
    await db
      .update(holidayCalendars)
      .set({ status: 'REEMPLAZADO' })
      .where(sql`${holidayCalendars.year} = 2026`);
    await calendar(2026, ['2026-03-04', '2026-03-23'], 2);
    await send(fin, 'post', `/approvals/vacations/final/${a.body.id}/approve`).expect(409);
    expect(await status(a.body.id)).toBe('PENDIENTE_FINAL');
    expect(await db.select().from(vacaciones)).toHaveLength(0);
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(10);
    await send(fin, 'post', `/approvals/vacations/final/${a.body.id}/reject`, {
      reason: 'Debe recalcularse con el nuevo calendario',
    }).expect(200);
    expect(await status(a.body.id)).toBe('RECHAZADA');
  });
});
