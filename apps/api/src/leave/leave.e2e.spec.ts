import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, employeeSnapshots, progVac, roleAssignments } from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';

describe.skipIf(!url)('festivos, PROG_VAC y cálculo previo (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let hr = { cookie: '', csrf: '' };
  let emp = { cookie: '', csrf: '' };
  const srv = () => app.getHttpServer();

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

  async function login(email: string) {
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  async function person(nIde: string, email: string, role?: 'HR_ADMIN') {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email, est: 'V', nombre: nIde, cEmp: 'GA' });
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
    if (role)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role, validFrom: '2020-01-01' });
    return login(email);
  }
  const post = (s: typeof hr, path: string, body: object) =>
    request(srv()).post(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const put = (s: typeof hr, path: string, body: object) =>
    request(srv()).put(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const publishYear = async (year: number, days: { date: string; name: string }[]) => {
    const d = await post(hr, '/admin/holidays', {
      year,
      days,
      reason: 'Calendario de prueba del año',
    }).expect(201);
    await post(hr, `/admin/holidays/${d.body.id}/publish`, {}).expect(200);
    return d.body.id as string;
  };

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE prog_vac_adjustments, prog_vac, holidays, holiday_calendars, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    hr = await person('ADM', 'hr@x.co', 'HR_ADMIN');
    emp = await person('100', 'e@x.co');
  });

  it('festivos: borrador, publicación versionada y validaciones', async () => {
    await post(hr, '/admin/holidays', {
      year: 2026,
      days: [],
      reason: 'Sin días de prueba',
    }).expect(400);
    await post(hr, '/admin/holidays', {
      year: 2026,
      days: [{ date: '2027-01-01', name: 'Otro año' }],
      reason: 'Fecha de otro año',
    }).expect(400);
    const v1 = await publishYear(2026, [{ date: '2026-03-23', name: 'San José' }]);
    const v2 = await publishYear(2026, [
      { date: '2026-03-23', name: 'San José' },
      { date: '2026-05-01', name: 'Trabajo' },
    ]);
    const list = await request(srv())
      .get('/admin/holidays?year=2026')
      .set('Cookie', hr.cookie)
      .expect(200);
    const by = Object.fromEntries(
      list.body.map((c: { id: string; status: string }) => [c.id, c.status]),
    );
    expect(by[v1]).toBe('REEMPLAZADO');
    expect(by[v2]).toBe('PUBLICADO');
    await post(hr, `/admin/holidays/${v2}/publish`, {}).expect(409);
    await post(emp, '/admin/holidays', { year: 2026, days: [], reason: 'x'.repeat(12) }).expect(
      403,
    );
  });

  it('PROG_VAC: alta, validación 0<=DISP<=DIAS<=15, duplicado, ajuste con motivo y baja', async () => {
    const base = {
      nIde: '100',
      nCont: '1',
      perIni: '2025-01-01',
      perFin: '2025-12-31',
      dias: 15,
      disp: 15,
    };
    await post(hr, '/admin/prog-vac', { ...base, dias: 16, disp: 1 }).expect(400);
    await post(hr, '/admin/prog-vac', { ...base, disp: 16 }).expect(400);
    await post(hr, '/admin/prog-vac', { ...base, disp: -1 }).expect(400);
    await post(hr, '/admin/prog-vac', { ...base, nIde: '999' }).expect(400);
    const ok = await post(hr, '/admin/prog-vac', base).expect(201);
    await post(hr, '/admin/prog-vac', base).expect(409);
    await put(hr, `/admin/prog-vac/${ok.body.id}`, { dias: 15, disp: 10, reason: 'corto' }).expect(
      400,
    );
    await put(hr, `/admin/prog-vac/${ok.body.id}`, {
      dias: 15,
      disp: 0,
      reason: 'Disfrute registrado fuera del portal',
    }).expect(200);
    const [row] = await db.select().from(progVac);
    expect(row).toMatchObject({ disp: 0, estado: 'LIQUIDADA', version: 2 });
    const adj = await request(srv())
      .get(`/admin/prog-vac/${ok.body.id}/adjustments`)
      .set('Cookie', hr.cookie)
      .expect(200);
    expect(adj.body[0]).toMatchObject({ oldDisp: 15, newDisp: 0 });
    await request(srv())
      .delete(`/admin/prog-vac/${ok.body.id}`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf)
      .expect(204);
    await request(srv())
      .delete(`/admin/prog-vac/${ok.body.id}`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf)
      .expect(404);
    await request(srv()).get('/admin/prog-vac').set('Cookie', emp.cookie).expect(403);
  });

  it('la lista de empleados del alta manual trae solo activos con su contrato vigente', async () => {
    await db.insert(employeeSnapshots).values([
      { nIde: '300', nCont: '7', email: 'c@x.co', est: 'C', nombre: 'ANA CANCELADA' },
      { nIde: '400', nCont: '3', email: 'd@x.co', est: 'V', nombre: 'BRUNO DIAZ' },
    ]);
    const all = await request(srv())
      .get('/admin/prog-vac/employees')
      .set('Cookie', hr.cookie)
      .expect(200);
    const sorted = (all.body as { nIde: string }[])
      .slice()
      .sort((a, b) => a.nIde.localeCompare(b.nIde));
    expect(sorted).toEqual([
      { nIde: '100', nCont: '1', nombre: '100' },
      { nIde: '400', nCont: '3', nombre: 'BRUNO DIAZ' },
      { nIde: 'ADM', nCont: '1', nombre: 'ADM' },
    ]); // sin la cancelada
    const byName = await request(srv())
      .get('/admin/prog-vac/employees?q=bruno')
      .set('Cookie', hr.cookie)
      .expect(200);
    expect(byName.body).toHaveLength(1);
    const byId = await request(srv())
      .get('/admin/prog-vac/employees?q=40')
      .set('Cookie', hr.cookie)
      .expect(200);
    expect(byId.body.map((e: { nIde: string }) => e.nIde)).toEqual(['400']);
    const none = await request(srv())
      .get('/admin/prog-vac/employees?q=%25')
      .set('Cookie', hr.cookie)
      .expect(200);
    expect(none.body).toEqual([]); // el comodín se toma literalmente
    await request(srv()).get('/admin/prog-vac/employees').set('Cookie', emp.cookie).expect(403);
    await request(srv()).get('/admin/prog-vac/employees').expect(401);

    const base = { perIni: '2025-01-01', perFin: '2025-12-31', dias: 15, disp: 15 };
    await post(hr, '/admin/prog-vac', { ...base, nIde: '300', nCont: '7' }).expect(400); // cancelado
    await post(hr, '/admin/prog-vac', { ...base, nIde: '400', nCont: '1' }).expect(400); // contrato que no es el suyo
    await post(hr, '/admin/prog-vac', { ...base, nIde: '400', nCont: '3' }).expect(201);
  });

  it('el empleado ve solo sus períodos con DISP > 0 y calcula fechas', async () => {
    const other = await person('200', 'o@x.co');
    void other;
    const a = await post(hr, '/admin/prog-vac', {
      nIde: '100',
      nCont: '1',
      perIni: '2024-01-01',
      perFin: '2024-12-31',
      dias: 15,
      disp: 5,
    });
    await post(hr, '/admin/prog-vac', {
      nIde: '100',
      nCont: '1',
      perIni: '2023-01-01',
      perFin: '2023-12-31',
      dias: 15,
      disp: 0,
    });
    const b = await post(hr, '/admin/prog-vac', {
      nIde: '200',
      nCont: '1',
      perIni: '2024-01-01',
      perFin: '2024-12-31',
      dias: 15,
      disp: 15,
    });
    const mine = await request(srv())
      .get('/me/vacations/periods')
      .set('Cookie', emp.cookie)
      .expect(200);
    expect(mine.body.map((p: { id: string }) => p.id)).toEqual([a.body.id]);

    const body = { start: '2026-12-28', allocations: [{ progVacId: a.body.id, days: 5 }] };
    const missing = await post(emp, '/me/vacations/preview', body).expect(422);
    expect(missing.body).toMatchObject({ code: 'HOLIDAY_CALENDAR_MISSING', years: [2026, 2027] });

    await publishYear(2026, [{ date: '2026-12-31', name: 'Prueba' }]);
    await post(emp, '/me/vacations/preview', body).expect(422); // falta 2027
    await publishYear(2027, [{ date: '2027-01-01', name: 'Año Nuevo' }]);
    const ok = await post(emp, '/me/vacations/preview', body).expect(200);
    expect(ok.body).toMatchObject({
      start: '2026-12-28',
      end: '2027-01-05',
      calendarDiff: 8,
      businessDays: 5,
      returnDate: '2027-01-06',
    });
    expect(ok.body.calendarIds).toHaveLength(2);

    await post(emp, '/me/vacations/preview', {
      ...body,
      allocations: [{ progVacId: a.body.id, days: 6 }],
    }).expect(400);
    await post(emp, '/me/vacations/preview', {
      ...body,
      allocations: [{ progVacId: b.body.id, days: 1 }],
    }).expect(404);
    await post(emp, '/me/vacations/preview', { ...body, start: '2026-12-31' }).expect(400);
    await request(srv()).post('/me/vacations/preview').send(body).expect(401);
  });
});
