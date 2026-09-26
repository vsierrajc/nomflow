import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, auditLogs, employeeSnapshots, roleAssignments, sessions } from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { hashPassword } from './password.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const ASSIGNED = 'Clave-Asignada-Por-RRHH-7';
type Sess = { cookie: string; csrf: string; id: string };

describe.skipIf(!url)('clave asignada por el administrador (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  const sent: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = {
    send: (to, subject, text) => {
      sent.push({ to, subject, text });
      return Promise.resolve();
    },
  };
  let adm: Sess;

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

  const login = (email: string, password: string) =>
    request(srv()).post('/auth/login').send({ email, password });
  async function sessionOf(email: string, id: string, password = PASSWORD): Promise<Sess> {
    const res = await login(email, password).expect(200);
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
      id,
    };
  }
  async function person(
    nIde: string,
    email: string,
    opts: {
      admin?: 'HR_ADMIN' | 'SYSTEM_ADMIN';
      status?: 'ACTIVA' | 'PENDIENTE_VERIFICACION' | 'BLOQUEADA';
    } = {},
  ) {
    await db.insert(employeeSnapshots).values({ nIde, nCont: '1', email, est: 'V', nombre: nIde });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: opts.status ?? 'ACTIVA',
        mustChangePassword: (opts.status ?? 'ACTIVA') !== 'ACTIVA',
        emailVerifiedAt: opts.status === 'PENDIENTE_VERIFICACION' ? null : new Date(),
      })
      .returning({ id: accounts.id });
    if (opts.admin)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role: opts.admin, validFrom: '2020-01-01' });
    return a?.id ?? '';
  }
  const call = (s: Sess, method: 'get' | 'post', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };

  beforeEach(async () => {
    sent.length = 0;
    await db.execute(
      sql`TRUNCATE audit_logs, verification_codes, two_factor_challenges, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    const id = await person('ADM', 'adm@x.co', { admin: 'HR_ADMIN' });
    adm = await sessionOf('adm@x.co', id);
  });

  it('el usuario de acceso es el correo del empleado y se muestra en su ficha', async () => {
    await person('100', 'ana@x.co');
    const s = (await call(adm, 'get', '/admin/accounts/by-employee/100').expect(200)).body;
    expect(s).toMatchObject({
      exists: true,
      username: 'ana@x.co',
      status: 'ACTIVA',
      twoFactorEnabled: false,
    });
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '300', nCont: '1', email: 'Sin.Cuenta@X.co', est: 'V' });
    expect(
      (await call(adm, 'get', '/admin/accounts/by-employee/300').expect(200)).body,
    ).toMatchObject({
      exists: false,
      username: 'sin.cuenta@x.co',
      id: null,
    });
    await call(adm, 'get', '/admin/accounts/by-employee/999').expect(404);
  });

  it('cuenta activa sin exigir cambio: la clave asignada sirve de inmediato y se cierran sus sesiones', async () => {
    const id = await person('100', 'ana@x.co');
    const old = await sessionOf('ana@x.co', id);
    const res = await call(adm, 'post', `/admin/accounts/${id}/set-password`, {
      password: ASSIGNED,
      requireChange: false,
    }).expect(200);
    expect(res.body).toMatchObject({ status: 'ACTIVA', verificationSent: false });
    expect(JSON.stringify(res.body)).not.toContain(ASSIGNED);
    await login('ana@x.co', PASSWORD).expect(401); // la anterior ya no sirve
    await login('ana@x.co', ASSIGNED).expect(200);
    await request(srv()).get('/auth/me').set('Cookie', old.cookie).expect(401); // sesión cerrada
    expect(sent).toHaveLength(0);
    const audit = JSON.stringify(await db.select().from(auditLogs));
    expect(audit).not.toContain(ASSIGNED);
    expect(audit).toContain('ACCOUNT_PASSWORD_SET');
  });

  it('exigiendo el cambio: queda pendiente, llega el código y se activa con la clave asignada', async () => {
    const id = await person('100', 'ana@x.co');
    const res = await call(adm, 'post', `/admin/accounts/${id}/set-password`, {
      password: ASSIGNED,
      requireChange: true,
    }).expect(200);
    expect(res.body).toMatchObject({ status: 'PENDIENTE_VERIFICACION', verificationSent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ana@x.co');
    expect(sent[0]?.text).not.toContain(ASSIGNED);
    await login('ana@x.co', ASSIGNED).expect(401); // aún no puede ingresar
    const code = /es ([A-Z0-9]{8})/.exec(sent[0]?.text ?? '')?.[1] ?? '';
    await request(srv())
      .post('/auth/activate')
      .send({
        email: 'ana@x.co',
        temporaryPassword: ASSIGNED,
        code,
        newPassword: 'Mi-Propia-Clave-Segura-3',
      })
      .expect(204);
    await login('ana@x.co', 'Mi-Propia-Clave-Segura-3').expect(200);
    await login('ana@x.co', ASSIGNED).expect(401);
  });

  it('valida la clave y respeta las reglas del sistema', async () => {
    const id = await person('100', 'ana@x.co');
    const set = (body: object, s = adm, target = id) =>
      call(s, 'post', `/admin/accounts/${target}/set-password`, body);
    await set({ password: 'corta', requireChange: true }).expect(400);
    await set({ password: 'ana@x.co', requireChange: true }).expect(400); // igual al usuario
    await set({ requireChange: true }).expect(400);
    await set({ password: 'x'.repeat(201), requireChange: true }).expect(400);
    // nunca a uno mismo, ni por quien no es administrador
    await set({ password: ASSIGNED }, adm, adm.id).expect(403);
    const anaSess = await sessionOf('ana@x.co', id);
    await set({ password: ASSIGNED }, anaSess).expect(403);
    await request(srv())
      .post(`/admin/accounts/${id}/set-password`)
      .send({ password: ASSIGNED })
      .expect(401);
    // cuenta bloqueada
    const blocked = await person('200', 'b@x.co', { status: 'BLOQUEADA' });
    await set({ password: ASSIGNED }, adm, blocked).expect(409);
    // una cuenta administradora solo la cambia un administrador del sistema
    const other = await person('ADM2', 'adm2@x.co', { admin: 'HR_ADMIN' });
    await set({ password: ASSIGNED }, adm, other).expect(403);
    const sysId = await person('SYS', 'sys@x.co', { admin: 'SYSTEM_ADMIN' });
    const sys = await sessionOf('sys@x.co', sysId);
    await set({ password: ASSIGNED, requireChange: false }, sys, other).expect(200);
    await login('adm2@x.co', ASSIGNED).expect(200);
    // empleado dado de baja
    await db.update(employeeSnapshots).set({ est: 'C' }).where(eq(employeeSnapshots.nIde, '100'));
    await set({ password: ASSIGNED }, adm, id).expect(422);
  });

  it('cuenta pendiente: sigue pendiente y recibe el código, aunque no se exija el cambio', async () => {
    const id = await person('100', 'ana@x.co', { status: 'PENDIENTE_VERIFICACION' });
    const res = await call(adm, 'post', `/admin/accounts/${id}/set-password`, {
      password: ASSIGNED,
      requireChange: false,
    }).expect(200);
    expect(res.body).toMatchObject({ status: 'PENDIENTE_VERIFICACION', verificationSent: true });
    await login('ana@x.co', ASSIGNED).expect(401); // el correo se verifica siempre en la primera vez
  });

  it('crear la cuenta con una clave elegida: no se devuelve y se activa con el código', async () => {
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '300', nCont: '1', email: 'nuevo@x.co', est: 'V', nombre: 'Nuevo' });
    await call(adm, 'post', '/admin/accounts', { nIde: '300', password: 'corta' }).expect(400);
    const res = await call(adm, 'post', '/admin/accounts', {
      nIde: '300',
      password: ASSIGNED,
    }).expect(201);
    expect(res.body.temporaryPassword).toBe('');
    expect(JSON.stringify(res.body)).not.toContain(ASSIGNED);
    expect(res.body.verificationSent).toBe(true);
    const code = /es ([A-Z0-9]{8})/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';
    await request(srv())
      .post('/auth/activate')
      .send({
        email: 'nuevo@x.co',
        temporaryPassword: ASSIGNED,
        code,
        newPassword: 'Mi-Propia-Clave-Segura-3',
      })
      .expect(204);
    // sin clave elegida, el sistema sigue generando una temporal
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '400', nCont: '1', email: 'otro@x.co', est: 'V', nombre: 'Otro' });
    const auto = await call(adm, 'post', '/admin/accounts', { nIde: '400' }).expect(201);
    expect(auto.body.temporaryPassword.length).toBeGreaterThan(10);
    expect((await db.select().from(sessions)).length).toBeGreaterThan(0);
  });

  it('activar ahora: con el correo caído la cuenta queda activa con la clave y sin enviar código', async () => {
    const id = await person('PEND', 'pend@x.co', { status: 'PENDIENTE_VERIFICACION' });
    const before = sent.length;
    const res = await call(adm, 'post', `/admin/accounts/${id}/set-password`, {
      password: ASSIGNED,
      requireChange: false,
      activateNow: true,
    }).expect(200);
    expect(res.body).toEqual({ status: 'ACTIVA', verificationSent: false });
    expect(sent.length).toBe(before); // no se envió ningún correo
    const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    expect(row).toMatchObject({ status: 'ACTIVA', mustChangePassword: false });
    expect(row?.emailVerifiedAt).not.toBeNull();
    await login('pend@x.co', ASSIGNED).expect(200); // ya puede ingresar con esa clave
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ACCOUNT_PASSWORD_SET'));
    expect(log?.context).toMatchObject({ activateNow: true });
    expect(JSON.stringify(log)).not.toContain(ASSIGNED);
    // una cuenta bloqueada no se activa por esta vía
    await db.update(accounts).set({ status: 'BLOQUEADA' }).where(eq(accounts.id, id));
    await call(adm, 'post', `/admin/accounts/${id}/set-password`, {
      password: ASSIGNED,
      requireChange: false,
      activateNow: true,
    }).expect(409);
  });
});
