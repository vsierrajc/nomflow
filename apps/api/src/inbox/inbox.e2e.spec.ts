import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  employeeSnapshots,
  permitRequests,
  permitTypes,
  roleAssignments,
  vacationRequests,
  vacationRevisions,
} from '../db/schema';
import { permitSteps, vacationSteps } from './inbox.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };

describe('pasos del flujo', () => {
  it('vacaciones: en qué paso va cada estado', () => {
    const st = (s: string) => vacationSteps(s).map((x) => x.state);
    expect(st('PENDIENTE_JEFE')).toEqual(['done', 'current', 'todo', 'todo']);
    expect(st('REVISION_EMPLEADO')).toEqual(['done', 'current', 'todo', 'todo']);
    expect(st('PENDIENTE_FINAL')).toEqual(['done', 'done', 'current', 'todo']);
    expect(st('APROBADA')).toEqual(['done', 'done', 'done', 'done']);
    expect(st('RECHAZADA')).toEqual(['done', 'rejected', 'todo', 'todo']);
    expect(st('CANCELADA')).toEqual(['done', 'cancelled', 'todo', 'todo']);
  });
  it('permisos: solo decide el jefe', () => {
    const st = (s: string) => permitSteps(s).map((x) => x.state);
    expect(st('PENDIENTE_JEFE')).toEqual(['done', 'current', 'todo']);
    expect(st('APROBADO')).toEqual(['done', 'done', 'done']);
    expect(st('RECHAZADO')).toEqual(['done', 'rejected', 'todo']);
  });
});

describe.skipIf(!url)('bandeja de entrada (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  const ids: Record<string, string> = {};
  const sess: Record<string, Sess> = {};

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

  async function person(
    key: string,
    roles: { role: 'VACATION_FINAL_APPROVER'; cEmp: string }[] = [],
  ) {
    const email = `${key.toLowerCase()}@x.co`;
    await db
      .insert(employeeSnapshots)
      .values({ nIde: key, nCont: '1', email, est: 'V', nombre: `PERSONA ${key}`, cEmp: 'GA' });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: key,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: accounts.id });
    ids[key] = a?.id ?? '';
    for (const r of roles)
      await db.insert(roleAssignments).values({
        accountId: ids[key] ?? '',
        role: r.role,
        companyCode: r.cEmp,
        validFrom: '2020-01-01',
      });
    const res = await request(srv())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    sess[key] = {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  const inbox = (k: string) =>
    request(srv())
      .get('/me/inbox')
      .set('Cookie', sess[k]?.cookie ?? '');

  async function vacation(owner: string, status: string, manager: string, cEmp = 'GA') {
    const [r] = await db
      .insert(vacationRequests)
      .values({
        accountId: ids[owner] ?? '',
        nIde: owner,
        nCont: '1',
        cEmp,
        cArea: 'A1',
        managerAccountId: ids[manager] ?? '',
        status,
      })
      .returning({ id: vacationRequests.id });
    await db.insert(vacationRevisions).values({
      requestId: r?.id ?? '',
      number: 1,
      startDate: '2026-11-02',
      endDate: '2026-11-13',
      calendarDiff: 12,
      businessDays: 10,
      returnDate: '2026-11-16',
      countedDays: [],
      calendarIds: [],
      proposedBy: ids[owner] ?? '',
      contentHash: 'h',
    });
    return r?.id ?? '';
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE vacation_revisions, vacation_requests, permit_requests, permit_types, sessions, role_assignments, accounts, employee_snapshots, audit_logs CASCADE`,
    );
    await person('EMP');
    await person('JEF');
    await person('FIN', [{ role: 'VACATION_FINAL_APPROVER', cEmp: 'GA' }]);
    await person('OTR', [{ role: 'VACATION_FINAL_APPROVER', cEmp: 'ZZ' }]);
  });

  it('exige sesión', async () => {
    await request(srv()).get('/me/inbox').expect(401);
    await request(srv()).get('/me/inbox/count').expect(401);
  });

  it('cada actor ve solo lo que le toca hacer', async () => {
    const v1 = await vacation('EMP', 'PENDIENTE_JEFE', 'JEF');
    const v2 = await vacation('EMP', 'PENDIENTE_FINAL', 'JEF');
    await vacation('EMP', 'APROBADA', 'JEF');
    const [pt] = await db
      .insert(permitTypes)
      .values({ code: 'REM', name: 'REMUNERADOS' })
      .returning({ id: permitTypes.id });
    const [pr] = await db
      .insert(permitRequests)
      .values({
        accountId: ids.EMP ?? '',
        nIde: 'EMP',
        nCont: '1',
        cEmp: 'GA',
        cArea: 'A1',
        managerAccountId: ids.JEF ?? '',
        typeId: pt?.id ?? '',
        typeName: 'REMUNERADOS',
        startDate: '2026-11-03',
        endDate: '2026-11-03',
        justification: 'Cita',
        contentHash: 'h',
      })
      .returning({ id: permitRequests.id });

    const jef = (await inbox('JEF').expect(200)).body;
    expect(jef.tasks.map((t: { kind: string; id: string }) => `${t.kind}:${t.id}`).sort()).toEqual(
      [`VACACION_JEFE:${v1}`, `PERMISO_JEFE:${pr?.id}`].sort(),
    );
    expect(jef.tasks[0].who).toBe('PERSONA EMP');
    expect(jef.tasks.find((t: { kind: string }) => t.kind === 'VACACION_JEFE').detail).toBe(
      '2026-11-02 a 2026-11-13',
    );

    const fin = (await inbox('FIN').expect(200)).body;
    expect(fin.tasks.map((t: { kind: string; id: string }) => `${t.kind}:${t.id}`)).toEqual([
      `VACACION_FINAL:${v2}`,
    ]);
    // aprobador de otra empresa: nada
    expect((await inbox('OTR').expect(200)).body.tasks).toEqual([]);

    // el empleado no tiene tareas, pero ve el avance de sus solicitudes
    const emp = (await inbox('EMP').expect(200)).body;
    expect(emp.tasks).toEqual([]);
    const byStatus = Object.fromEntries(
      emp.flows.map((f: { status: string; steps: { state: string }[] }) => [
        f.status,
        f.steps.map((s) => s.state),
      ]),
    );
    expect(byStatus.PENDIENTE_JEFE).toEqual(['done', 'current', 'todo', 'todo']);
    expect(byStatus.PENDIENTE_FINAL).toEqual(['done', 'done', 'current', 'todo']);
    expect(byStatus.APROBADA).toEqual(['done', 'done', 'done', 'done']);
    expect(emp.flows.some((f: { kind: string }) => f.kind === 'PERMISO')).toBe(true);
  });

  it('el empleado tiene la tarea de aceptar un cambio propuesto y el contador la suma', async () => {
    const v = await vacation('EMP', 'REVISION_EMPLEADO', 'JEF');
    const emp = (await inbox('EMP').expect(200)).body;
    expect(emp.tasks).toHaveLength(1);
    expect(emp.tasks[0]).toMatchObject({ kind: 'VACACION_ACEPTAR', id: v, href: '/vacaciones' });
    const c = await request(srv())
      .get('/me/inbox/count')
      .set('Cookie', sess.EMP?.cookie ?? '')
      .expect(200);
    expect(c.body).toEqual({ pending: 1 });
    const none = await request(srv())
      .get('/me/inbox/count')
      .set('Cookie', sess.JEF?.cookie ?? '')
      .expect(200);
    expect(none.body).toEqual({ pending: 0 });
  });

  it('las solicitudes viejas ya resueltas no aparecen en el seguimiento', async () => {
    const v = await vacation('EMP', 'RECHAZADA', 'JEF');
    await db
      .update(vacationRequests)
      .set({ updatedAt: new Date(Date.now() - 30 * 86_400_000) })
      .where(sql`id = ${v}`);
    expect((await inbox('EMP').expect(200)).body.flows).toEqual([]);
  });
});
