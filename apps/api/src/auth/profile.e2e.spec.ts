import type { INestApplication } from '@nestjs/common';
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

describe.skipIf(!url)('GET /auth/me devuelve el perfil (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;

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

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1', nCont: '1', email: 'ana@x.co', est: 'V', nombre: 'ANA PRUEBA' });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: '1',
        email: 'ana@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    await db.insert(roleAssignments).values([
      {
        accountId: a?.id ?? '',
        role: 'AREA_MANAGER',
        companyCode: 'GA',
        areaCode: '10300',
        validFrom: '2020-01-01',
      },
      {
        accountId: a?.id ?? '',
        role: 'CERTIFICATE_APPROVER',
        validFrom: '2020-01-01',
        validTo: '2021-01-01',
      },
      { accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2999-01-01' },
    ]);
  });

  it('incluye correo, nombre, roles vigentes (no vencidos ni futuros) y CSRF, sin caché', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@x.co', password: PASSWORD });
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0] ?? '';
    const res = await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({ email: 'ana@x.co', name: 'ANA PRUEBA' });
    expect(res.body.roles).toEqual([
      expect.objectContaining({ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }),
    ]);
    expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|nIde|n_ide/i);
  });
});
