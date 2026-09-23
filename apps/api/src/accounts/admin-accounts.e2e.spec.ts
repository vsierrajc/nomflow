import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, employeeSnapshots, roleAssignments } from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { hashPassword } from './password.service';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('POST /admin/accounts (sesión + rol + reautenticación)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const sent: string[] = [];
  const mailer: Mailer = {
    send: (to) => {
      sent.push(to);
      return Promise.resolve();
    },
  };
  const PASSWORD = 'Clave-Definitiva-1';

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.execute(
      sql`TRUNCATE audit_logs, verification_codes, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1234567890', nCont: '1', email: 'ana@x.co', est: 'V' });
  });

  async function user(email: string, nIde: string, role?: 'HR_ADMIN', validTo?: string) {
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
    if (role && a) {
      await db
        .insert(roleAssignments)
        .values({ accountId: a.id, role, validFrom: '2020-01-01', validTo: validTo ?? null });
    }
    return a?.id ?? '';
  }

  async function session(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }

  const create = (s: { cookie: string; csrf: string }, body: object = { nIde: '1234567890' }) =>
    request(app.getHttpServer())
      .post('/admin/accounts')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .send(body);

  it('exige sesión', async () => {
    expect((await request(app.getHttpServer()).post('/admin/accounts').send({})).status).toBe(401);
  });

  it('un administrador crea la cuenta: 201, sin caché, con clave temporal y correo enviado', async () => {
    await user('hr@x.co', 'ADM1', 'HR_ADMIN');
    const res = await create(await session('hr@x.co'));
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(res.body.verificationSent).toBe(true);
    expect(sent).toEqual(['ana@x.co']);
  });

  it('un empleado sin rol recibe 403 y no se crea nada', async () => {
    await user('emp@x.co', 'EMP1');
    await db
      .insert(employeeSnapshots)
      .values({ nIde: 'EMP1', nCont: '1', email: 'emp@x.co', est: 'V' });
    const res = await create(await session('emp@x.co'));
    expect(res.status).toBe(403);
    expect(
      await db
        .select()
        .from(accounts)
        .where(sql`n_ide = '1234567890'`),
    ).toHaveLength(0);
  });

  it('rechaza un rol HR_ADMIN vencido', async () => {
    await user('hr@x.co', 'ADM1', 'HR_ADMIN');
    const s = await session('hr@x.co');
    await db.update(roleAssignments).set({ validTo: '2021-01-01' });
    expect((await create(s)).status).toBe(403);
  });

  it('exige CSRF', async () => {
    await user('hr@x.co', 'ADM1', 'HR_ADMIN');
    const s = await session('hr@x.co');
    const res = await request(app.getHttpServer())
      .post('/admin/accounts')
      .set('Cookie', s.cookie)
      .send({ nIde: '1234567890' });
    expect(res.status).toBe(403);
  });

  it('exige reautenticación reciente y se recupera con /auth/reauth', async () => {
    await user('hr@x.co', 'ADM1', 'HR_ADMIN');
    const s = await session('hr@x.co');
    await db.execute(sql`UPDATE sessions SET created_at = now() - interval '11 minutes'`);
    const stale = await create(s);
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');

    const bad = await request(app.getHttpServer())
      .post('/auth/reauth')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .send({ password: 'incorrecta' });
    expect(bad.status).toBe(401);
    expect((await create(s)).status).toBe(403);

    const ok = await request(app.getHttpServer())
      .post('/auth/reauth')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .send({ password: PASSWORD });
    expect(ok.status).toBe(204);
    expect((await create(s)).status).toBe(201);
  });

  it('mapea errores: 404 empleado inexistente, 409 duplicada, 422 sin contrato vigente, 400 cuerpo inválido', async () => {
    await user('hr@x.co', 'ADM1', 'HR_ADMIN');
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '555555', nCont: '1', email: 'baja@x.co', est: 'C' });
    const s = await session('hr@x.co');
    expect((await create(s, { nIde: '999999' })).status).toBe(404);
    const c422 = await create(s, { nIde: '555555' });
    expect(c422.status).toBe(422);
    expect(c422.body.code).toBe('NO_ACTIVE_CONTRACT');
    expect((await create(s)).status).toBe(201);
    expect((await create(s)).status).toBe(409);
    expect((await create(s, { nIde: 1 })).status).toBe(400);
  });

  it('un administrador puede iniciar sesión sin ser empleado vigente; sin rol no', async () => {
    await user('hr@x.co', 'ADM1', 'HR_ADMIN');
    await user('otro@x.co', 'EMP9');
    expect(
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'hr@x.co', password: PASSWORD })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'otro@x.co', password: PASSWORD })
      ).status,
    ).toBe(401);
  });
});
