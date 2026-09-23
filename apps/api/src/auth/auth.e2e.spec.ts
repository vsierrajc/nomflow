import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, auditLogs, employeeSnapshots, sessions } from '../db/schema';
import { revokeAllForAccount } from './session.service';

const url = process.env.DATABASE_URL;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';

describe.skipIf(!url)('login y sesiones (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const PASSWORD = 'Clave-Definitiva-1';

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

  async function seed(over: Partial<typeof accounts.$inferInsert> = {}, est: 'V' | 'C' = 'V') {
    await db.insert(employeeSnapshots).values({ nIde: '1001', nCont: '1', email: 'ana@x.co', est });
    await db.insert(accounts).values({
      nIde: '1001',
      email: 'ana@x.co',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVA',
      mustChangePassword: false,
      ...over,
    });
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
  });

  const login = (email = 'ana@x.co', password = PASSWORD) =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password });

  it('inicia sesión con cookie HttpOnly SameSite=Strict y devuelve token CSRF', async () => {
    await seed();
    const res = await login(' ANA@x.co ');
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']?.[0]);
    expect(cookie).toContain('nf_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie.split(';')[0] ?? '');
    expect(me.status).toBe(200);
  });

  it('no guarda el token de sesión en claro', async () => {
    await seed();
    const res = await login();
    const token = String(res.headers['set-cookie']?.[0]).split(';')[0]?.split('=')[1] ?? '';
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('responde igual ante correo inexistente y clave errónea', async () => {
    await seed();
    const a = await login('nadie@x.co', PASSWORD);
    const b = await login('ana@x.co', 'incorrecta');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('bloquea tras 5 intentos fallidos incluso con la clave correcta', async () => {
    await seed();
    for (let i = 0; i < 5; i++) await login('ana@x.co', 'mala');
    const res = await login();
    expect(res.status).toBe(401);
    const reasons = (await db.select().from(auditLogs)).map((l) => l.result);
    expect(reasons).toContain('ACCOUNT_LOCKED');
  });

  it('rechaza cuenta pendiente, con cambio de clave obligatorio y contrato cancelado', async () => {
    await seed({ status: 'PENDIENTE_VERIFICACION' });
    expect((await login()).status).toBe(401);
    await db.execute(sql`TRUNCATE accounts, employee_snapshots CASCADE`);
    await seed({ mustChangePassword: true });
    expect((await login()).status).toBe(401);
    await db.execute(sql`TRUNCATE accounts, employee_snapshots CASCADE`);
    await seed({}, 'C');
    expect((await login()).status).toBe(401);
    const reasons = (await db.select().from(auditLogs)).map((l) => l.result);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'ACCOUNT_NOT_ACTIVE',
        'PASSWORD_CHANGE_REQUIRED',
        'EMPLOYMENT_NOT_ACTIVE',
      ]),
    );
  });

  it('exige CSRF para cerrar sesión y la revoca', async () => {
    await seed();
    const res = await login();
    const cookie = String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '';
    const srv = app.getHttpServer();
    expect((await request(srv).post('/auth/logout').set('Cookie', cookie)).status).toBe(403);
    expect(
      (
        await request(srv)
          .post('/auth/logout')
          .set('Cookie', cookie)
          .set('X-CSRF-Token', 'x'.repeat(64))
      ).status,
    ).toBe(403);
    const out = await request(srv)
      .post('/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', res.body.csrfToken);
    expect(out.status).toBe(204);
    expect((await request(srv).get('/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('rechaza sin cookie y con token inventado', async () => {
    const srv = app.getHttpServer();
    expect((await request(srv).get('/auth/me')).status).toBe(401);
    expect((await request(srv).get('/auth/me').set('Cookie', 'nf_session=falso')).status).toBe(401);
  });

  it('revocar todas las sesiones de la cuenta invalida la sesión al instante', async () => {
    await seed();
    const res = await login();
    const cookie = String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '';
    const [acc] = await db.select().from(accounts);
    await revokeAllForAccount(db, acc?.id ?? '');
    expect((await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie)).status).toBe(
      401,
    );
  });

  it('expira la sesión por inactividad', async () => {
    await seed();
    const res = await login();
    const cookie = String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '';
    await db.execute(sql`UPDATE sessions SET last_seen_at = now() - interval '31 minutes'`);
    expect((await request(app.getHttpServer()).get('/auth/me').set('Cookie', cookie)).status).toBe(
      401,
    );
  });

  it('valida el cuerpo del login', async () => {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: 'x' });
    expect(res.status).toBe(400);
  });
});
