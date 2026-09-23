import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, auditLogs, employeeSnapshots } from '../db/schema';

const url = process.env.DATABASE_URL;
const OLD = 'Clave-Actual-Segura-1';
const NEW = 'Clave-Nueva-Segura-2';

describe.skipIf(!url)('POST /auth/change-password (HTTP + PostgreSQL)', () => {
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
    await db.execute(sql`TRUNCATE audit_logs, sessions, accounts, employee_snapshots CASCADE`);
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1', nCont: '1', email: 'ana@x.co', est: 'V' });
    await db.insert(accounts).values({
      nIde: '1',
      email: 'ana@x.co',
      passwordHash: await hashPassword(OLD),
      status: 'ACTIVA',
      mustChangePassword: false,
    });
  });

  const srv = () => app.getHttpServer();
  const login = async (password = OLD) => {
    const res = await request(srv()).post('/auth/login').send({ email: 'ana@x.co', password });
    return {
      status: res.status,
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  };
  const change = (s: { cookie: string; csrf: string }, body: object) =>
    request(srv())
      .post('/auth/change-password')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .send(body);

  it('cambia la clave: la vieja deja de servir, la nueva entra y las otras sesiones se cierran', async () => {
    const a = await login();
    const b = await login();
    expect((await change(a, { currentPassword: OLD, newPassword: NEW })).status).toBe(204);
    expect((await login(OLD)).status).toBe(401);
    expect((await login(NEW)).status).toBe(200);
    expect((await request(srv()).get('/auth/me').set('Cookie', a.cookie)).status).toBe(200);
    expect((await request(srv()).get('/auth/me').set('Cookie', b.cookie)).status).toBe(401);
  });

  it('rechaza la clave actual incorrecta, sin cambiarla, y bloquea tras 5 fallos', async () => {
    const s = await login();
    for (let i = 0; i < 5; i++)
      expect((await change(s, { currentPassword: 'mala', newPassword: NEW })).status).toBe(401);
    expect((await change(s, { currentPassword: OLD, newPassword: NEW })).status).toBe(401);
    const [acc] = await db.select().from(accounts);
    expect(acc?.lockedUntil).not.toBeNull();
  });

  it('exige al menos 12 caracteres y distinta de la actual', async () => {
    const s = await login();
    expect((await change(s, { currentPassword: OLD, newPassword: 'corta' })).status).toBe(400);
    expect((await change(s, { currentPassword: OLD, newPassword: OLD })).status).toBe(400);
    expect((await login(OLD)).status).toBe(200);
  });

  it('exige sesión, CSRF y cuerpo válido', async () => {
    expect(
      (
        await request(srv())
          .post('/auth/change-password')
          .send({ currentPassword: OLD, newPassword: NEW })
      ).status,
    ).toBe(401);
    const s = await login();
    expect(
      (
        await request(srv())
          .post('/auth/change-password')
          .set('Cookie', s.cookie)
          .send({ currentPassword: OLD, newPassword: NEW })
      ).status,
    ).toBe(403);
    expect((await change(s, { currentPassword: OLD })).status).toBe(400);
  });

  it('audita sin guardar ninguna clave', async () => {
    const s = await login();
    await change(s, { currentPassword: 'mala', newPassword: NEW });
    await change(s, { currentPassword: OLD, newPassword: NEW });
    const logs = (await db.select().from(auditLogs)).filter((l) => l.action === 'PASSWORD_CHANGE');
    expect(logs.map((l) => l.result).sort()).toEqual(['INVALID_CREDENTIALS', 'SUCCESS']);
    const dump = JSON.stringify(await db.select().from(auditLogs));
    for (const secret of [OLD, NEW, 'mala']) expect(dump).not.toContain(secret);
  });
});
