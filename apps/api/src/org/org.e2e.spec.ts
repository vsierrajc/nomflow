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
  auditLogs,
  catalogEntries,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { resolveAreaManager } from './area-managers.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };

describe.skipIf(!url)('roles con alcance y jefes de área (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let hr = { cookie: '', csrf: '', id: '' };
  let boss = '';

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

  async function account(
    email: string,
    nIde: string,
    role?: 'HR_ADMIN' | 'SYSTEM_ADMIN',
    status: 'ACTIVA' | 'PENDIENTE_VERIFICACION' = 'ACTIVA',
  ) {
    const [a] = await db
      .insert(accounts)
      .values({
        nIde,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status,
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    if (role)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role, validFrom: '2020-01-01' });
    return a?.id ?? '';
  }
  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, area_manager_assignments, catalog_entry_history, catalog_entries, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db.insert(catalogEntries).values([
      { type: 'AREA', cEmp: 'GA', code: '10300', name: 'FINANCIERA' },
      { type: 'AREA', cEmp: 'GA', code: '10400', name: 'COMERCIAL' },
    ]);
    const id = await account('hr@x.co', 'ADM1', 'HR_ADMIN');
    hr = { ...(await login('hr@x.co')), id };
    boss = await account('jefe@x.co', '84069561');
  });

  const srv = () => app.getHttpServer();
  const post = (path: string, body: object, s: Sess = hr) =>
    request(srv()).post(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const grant = (role: string, extra: object = {}, target = boss, s: Sess = hr) =>
    post(`/admin/accounts/${target}/roles`, { role, validFrom: '2020-01-01', ...extra }, s);
  const managerRole = () => grant('AREA_MANAGER', { cEmp: 'GA', areaCode: '10300' });
  const assign = (extra: object = {}, s: Sess = hr) =>
    post(
      '/admin/areas/managers',
      { cEmp: 'GA', cArea: '10300', managerAccountId: boss, validFrom: '2026-01-01', ...extra },
      s,
    );

  describe('concesión de roles', () => {
    it('concede AREA_MANAGER con alcance y lo audita', async () => {
      const res = await managerRole();
      expect(res.status).toBe(201);
      const [row] = await db
        .select()
        .from(roleAssignments)
        .where(sql`role = 'AREA_MANAGER'`);
      expect(row).toMatchObject({ companyCode: 'GA', areaCode: '10300' });
      expect(
        (await db.select().from(auditLogs)).some(
          (l) => l.action === 'ROLE_GRANT' && l.result === 'SUCCESS',
        ),
      ).toBe(true);
    });

    it('exige alcance y un área existente para AREA_MANAGER', async () => {
      expect((await grant('AREA_MANAGER')).status).toBe(422);
      expect((await grant('AREA_MANAGER', { cEmp: 'GA', areaCode: 'NOEXISTE' })).status).toBe(404);
    });

    it('valida rango de fechas, cuenta destino y cuerpo', async () => {
      expect((await grant('EMPLOYEE', { validFrom: '2026-02-30' })).status).toBe(422);
      expect((await grant('EMPLOYEE', { validTo: '2019-01-01' })).status).toBe(422);
      expect((await grant('EMPLOYEE', {}, '00000000-0000-4000-8000-000000000000')).status).toBe(
        404,
      );
      expect((await grant('INVENTADO')).status).toBe(400);
    });

    it('nadie se concede roles a sí mismo', async () => {
      expect((await grant('AREA_MANAGER', { cEmp: 'GA', areaCode: '10300' }, hr.id)).status).toBe(
        403,
      );
    });

    it('HR_ADMIN no puede escalar: conceder HR_ADMIN o SYSTEM_ADMIN exige SYSTEM_ADMIN', async () => {
      expect((await grant('SYSTEM_ADMIN')).status).toBe(403);
      expect((await grant('HR_ADMIN')).status).toBe(403);
      await account('sys@x.co', 'SYS1', 'SYSTEM_ADMIN');
      const sys = await login('sys@x.co');
      expect((await grant('HR_ADMIN', {}, boss, sys)).status).toBe(201);
    });

    it('un empleado sin rol administrativo recibe 403', async () => {
      await db
        .insert(employeeSnapshots)
        .values({ nIde: '84069561', nCont: '1', email: 'jefe@x.co', est: 'V' });
      const s = await login('jefe@x.co');
      expect((await grant('EMPLOYEE', {}, boss, s)).status).toBe(403);
    });

    it('exige reautenticación reciente', async () => {
      await db.execute(sql`UPDATE sessions SET created_at = now() - interval '11 minutes'`);
      expect((await managerRole()).status).toBe(403);
    });
  });

  describe('asignación de jefe de área', () => {
    it('asigna al jefe y se resuelve por fecha', async () => {
      await managerRole();
      const res = await assign();
      expect(res.status).toBe(201);
      expect(await resolveAreaManager(db, 'GA', '10300', '2026-06-01')).toBe(boss);
      expect(await resolveAreaManager(db, 'GA', '10300', '2025-12-31')).toBeNull();
      expect(await resolveAreaManager(db, 'GA', '10400', '2026-06-01')).toBeNull();
    });

    it('rechaza a quien no tiene AREA_MANAGER de esa área o no está activo', async () => {
      expect((await assign()).status).toBe(422);
      await grant('AREA_MANAGER', { cEmp: 'GA', areaCode: '10400' });
      expect((await assign()).status).toBe(422);
      const pending = await account('pend@x.co', '999', undefined, 'PENDIENTE_VERIFICACION');
      await grant('AREA_MANAGER', { cEmp: 'GA', areaCode: '10300' }, pending);
      expect((await assign({ managerAccountId: pending })).status).toBe(422);
    });

    it('rechaza si el rol no cubre el periodo pedido', async () => {
      await grant('AREA_MANAGER', { cEmp: 'GA', areaCode: '10300', validTo: '2026-03-31' });
      expect((await assign({ validTo: '2026-12-31' })).status).toBe(422);
      expect((await assign({ validTo: '2026-03-01' })).status).toBe(201);
    });

    it('no permite periodos solapados y sí consecutivos', async () => {
      await managerRole();
      expect((await assign({ validFrom: '2026-01-01', validTo: '2026-06-30' })).status).toBe(201);
      expect((await assign({ validFrom: '2026-06-30', validTo: '2026-12-31' })).status).toBe(409);
      expect((await assign({ validFrom: '2026-07-01' })).status).toBe(201);
      expect((await assign({ validFrom: '2030-01-01' })).status).toBe(409);
    });

    it('cerrar una asignación permite otra después y conserva el historial', async () => {
      await managerRole();
      const first = await assign();
      const other = await account('otro@x.co', 'OTRO');
      await grant('AREA_MANAGER', { cEmp: 'GA', areaCode: '10300' }, other);
      expect((await assign({ managerAccountId: other, validFrom: '2026-06-01' })).status).toBe(409);
      const end = await request(srv())
        .put(`/admin/areas/managers/${first.body.id}/end`)
        .set('Cookie', hr.cookie)
        .set('X-CSRF-Token', hr.csrf)
        .send({ validTo: '2026-05-31' });
      expect(end.status).toBe(204);
      expect((await assign({ managerAccountId: other, validFrom: '2026-06-01' })).status).toBe(201);
      expect(await resolveAreaManager(db, 'GA', '10300', '2026-05-15')).toBe(boss);
      expect(await resolveAreaManager(db, 'GA', '10300', '2026-06-15')).toBe(other);
      const list = await request(srv())
        .get('/admin/areas/GA/10300/managers')
        .set('Cookie', hr.cookie);
      expect(list.body).toHaveLength(2);
    });

    it('dos asignaciones simultáneas del mismo periodo dejan solo una', async () => {
      await managerRole();
      const [a, b] = await Promise.all([assign(), assign()]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('un área inexistente o un cuerpo inválido se rechazan', async () => {
      await managerRole();
      expect((await assign({ cArea: 'NOEXISTE' })).status).toBe(404);
      expect((await assign({ managerAccountId: 'no-uuid' })).status).toBe(400);
      expect((await assign({ validFrom: '2026-02-30' })).status).toBe(422);
    });

    it('si el jefe se bloquea deja de resolverse', async () => {
      await managerRole();
      await assign();
      await db
        .update(accounts)
        .set({ status: 'BLOQUEADA' })
        .where(sql`id = ${boss}`);
      expect(await resolveAreaManager(db, 'GA', '10300', '2026-06-01')).toBeNull();
    });
  });
});
