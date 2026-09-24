import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, employeeSnapshots, roleAssignments } from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const DUMMY = '00000000-0000-4000-8000-000000000000';

interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  path: string;
}

const METHODS: Record<number, RouteInfo['method']> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

function send(app: INestApplication, r: RouteInfo, s?: { cookie: string; csrf: string }) {
  const agent = request(app.getHttpServer());
  let call = agent[r.method](r.path);
  if (s) call = call.set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  return call.send({});
}

function discover(app: INestApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const container = app.get(ModulesContainer);
  for (const mod of container.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (abstract new (...args: never[]) => unknown) | null;
      if (!cls) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = (cls.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (method === undefined || sub === undefined) continue;
        const httpMethod = METHODS[method];
        if (!httpMethod) continue;
        const path = `/${[base, sub].filter(Boolean).join('/')}`
          .replace(/\/+/g, '/')
          .replace(/:(\w+)/g, (_m, n: string) =>
            n === 'nIde'
              ? '1000000001'
              : n === 'per'
                ? '202609'
                : n === 'nLiq'
                  ? '1'
                  : n === 'contrato'
                    ? '1'
                    : n === 'kind'
                      ? 'AREA'
                      : DUMMY,
          );
        routes.push({ method: httpMethod, path });
      }
    }
  }
  return routes;
}

describe.skipIf(!url)(
  'acceso administrativo: todas las rutas /admin exigen perfil administrador',
  () => {
    const ctx = createDb(url ?? '');
    const db = ctx.db;
    let app: INestApplication;
    const sessions: Record<string, string> = {};
    let adminRoutes: RouteInfo[] = [];

    beforeAll(async () => {
      await runMigrations(url ?? '');
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
      adminRoutes = discover(app).filter((r) => r.path.startsWith('/admin'));
    });
    afterAll(async () => {
      await app.close();
      await ctx.pool.end();
    });

    async function user(
      email: string,
      role:
        | 'EMPLOYEE'
        | 'AREA_MANAGER'
        | 'VACATION_FINAL_APPROVER'
        | 'CERTIFICATE_APPROVER'
        | 'HR_ADMIN'
        | 'SYSTEM_ADMIN',
      nIde: string,
    ) {
      await db.insert(employeeSnapshots).values({ nIde, nCont: '1', email, est: 'V' });
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
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role, validFrom: '2020-01-01' });
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: PASSWORD });
      sessions[email] = String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '';
      return { cookie: sessions[email] ?? '', csrf: res.body.csrfToken as string };
    }

    beforeEach(async () => {
      await db.execute(
        sql`TRUNCATE audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
      );
    });

    it('descubre las rutas administrativas (si esta cifra baja, la enumeración falló)', () => {
      expect(adminRoutes.length).toBeGreaterThanOrEqual(45);
      expect(adminRoutes.filter((r) => r.method !== 'get').length).toBeGreaterThanOrEqual(25);
    });

    it('sin sesión, todas responden 401', async () => {
      for (const r of adminRoutes) {
        const res = await send(app, r);
        expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
      }
    });

    it.each([
      'EMPLOYEE',
      'AREA_MANAGER',
      'VACATION_FINAL_APPROVER',
      'CERTIFICATE_APPROVER',
    ] as const)('con el rol %s, todas responden 403 (sin efecto alguno)', async (role) => {
      const s = await user(`${role.toLowerCase()}@x.co`, role, `id-${role}`);
      const before = await db.select().from(accounts);
      for (const r of adminRoutes) {
        const res = await send(app, r, s);
        expect(res.status, `${role}: ${r.method.toUpperCase()} ${r.path}`).toBe(403);
      }
      expect(await db.select().from(accounts)).toHaveLength(before.length);
    });

    it.each(['HR_ADMIN', 'SYSTEM_ADMIN'] as const)(
      'con el rol %s, ninguna ruta responde 401 ni 403 por rol',
      async (role) => {
        const s = await user(`${role.toLowerCase()}@x.co`, role, `id-${role}`);
        for (const r of adminRoutes) {
          if (
            r.path.includes('/logo') &&
            r.method === 'post' &&
            !r.path.endsWith('reset') &&
            !r.path.endsWith('activate')
          )
            continue;
          const res = await send(app, r, s);
          expect(res.status, `${role}: ${r.method.toUpperCase()} ${r.path}`).not.toBe(401);
          if (res.status === 403)
            expect(
              res.body.code,
              `${role}: ${r.method.toUpperCase()} ${r.path}`,
            ).not.toBeUndefined();
        }
      },
    );

    it('las rutas de empleado (/me) no están bajo /admin y siguen abiertas al propio usuario', async () => {
      const s = await user('emp@x.co', 'EMPLOYEE', 'id-emp');
      expect(
        (await request(app.getHttpServer()).get('/me/payroll').set('Cookie', s.cookie)).status,
      ).toBe(200);
      expect(discover(app).filter((r) => r.path.startsWith('/me')).length).toBeGreaterThanOrEqual(
        2,
      );
    });
  },
);
