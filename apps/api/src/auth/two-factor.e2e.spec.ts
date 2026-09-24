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
  auditLogs,
  employeeSnapshots,
  roleAssignments,
  twoFactorChallenges,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string; id: string };

describe.skipIf(!url)('verificación en dos pasos por correo (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  const sent: { to: string; subject: string; text: string }[] = [];
  let failMail = false;
  const mailer: Mailer = {
    send: (to, subject, text) => {
      if (failMail) return Promise.reject(new Error('smtp caído'));
      sent.push({ to, subject, text });
      return Promise.resolve();
    },
  };
  let ana: Sess;
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

  const login = (email: string, password = PASSWORD) =>
    request(srv()).post('/auth/login').send({ email, password });
  const cookieOf = (res: request.Response) =>
    String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  async function sessionOf(email: string, id: string): Promise<Sess> {
    const res = await login(email).expect(200);
    return { cookie: cookieOf(res), csrf: res.body.csrfToken as string, id };
  }
  async function person(nIde: string, email: string, admin = false): Promise<Sess> {
    await db.insert(employeeSnapshots).values({ nIde, nCont: '1', email, est: 'V', nombre: nIde });
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
    if (admin)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
    return sessionOf(email, a?.id ?? '');
  }
  const call = (s: Sess, method: 'get' | 'post', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };
  const lastCode = () => /es (\d{6})\./.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';

  /** Activa el doble paso de Ana por la API, como lo haría ella desde «Mi cuenta». */
  async function enableFor(s: Sess) {
    const start = await call(s, 'post', '/me/two-factor/start').expect(200);
    await call(s, 'post', '/me/two-factor/confirm', {
      challengeId: start.body.challengeId,
      code: lastCode(),
    }).expect(200);
  }

  beforeEach(async () => {
    sent.length = 0;
    failMail = false;
    await db.execute(
      sql`TRUNCATE two_factor_challenges, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    adm = await person('ADM', 'adm@x.co', true);
    ana = await person('100', 'ana@x.co');
  });

  it('es opcional: sin activarlo, el ingreso es como siempre', async () => {
    const res = await login('ana@x.co').expect(200);
    expect(res.body.twoFactorRequired).toBeUndefined();
    expect(cookieOf(res)).toContain('nf_session');
    expect((await call(ana, 'get', '/me/two-factor').expect(200)).body).toMatchObject({
      enabled: false,
    });
    expect(sent).toHaveLength(0);
    expect((await call(ana, 'get', '/auth/me').expect(200)).body.twoFactorEnabled).toBe(false);
  });

  it('activarlo: envía un código de 6 dígitos al correo y solo el código correcto lo activa', async () => {
    const start = await call(ana, 'post', '/me/two-factor/start').expect(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ana@x.co');
    expect(lastCode()).toMatch(/^\d{6}$/);
    const rows = await db.select().from(twoFactorChallenges);
    expect(JSON.stringify(rows)).not.toContain(lastCode()); // solo se guarda el hash

    await call(ana, 'post', '/me/two-factor/confirm', {
      challengeId: start.body.challengeId,
      code: '000000',
    }).expect(400);
    expect((await call(ana, 'get', '/me/two-factor').expect(200)).body.enabled).toBe(false);
    await call(ana, 'post', '/me/two-factor/confirm', {
      challengeId: start.body.challengeId,
      code: lastCode(),
    }).expect(200);
    const state = (await call(ana, 'get', '/me/two-factor').expect(200)).body;
    expect(state.enabled).toBe(true);
    expect(state.enabledAt).toBeTruthy();
    expect((await call(ana, 'get', '/auth/me').expect(200)).body.twoFactorEnabled).toBe(true);
    await call(ana, 'post', '/me/two-factor/start').expect(409); // ya activado
    // el mismo código no sirve dos veces
    await call(ana, 'post', '/me/two-factor/confirm', {
      challengeId: start.body.challengeId,
      code: lastCode(),
    }).expect(409);
  });

  it('con el doble paso activo, la clave sola no abre sesión: hace falta el código', async () => {
    await enableFor(ana);
    sent.length = 0;
    const first = await login('ana@x.co').expect(200);
    expect(first.body.twoFactorRequired).toBe(true);
    expect(first.body.csrfToken).toBeUndefined();
    expect(cookieOf(first)).toBe(''); // no hay sesión todavía
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('dos pasos');
    await request(srv()).get('/auth/me').expect(401);

    const verify = (code: string, challengeId = first.body.challengeId as string) =>
      request(srv()).post('/auth/login/verify').send({ challengeId, code });
    await verify('123456').expect(401);
    const ok = await verify(lastCode()).expect(200);
    expect(cookieOf(ok)).toContain('nf_session');
    expect(ok.body.csrfToken).toBeTruthy();
    await request(srv()).get('/auth/me').set('Cookie', cookieOf(ok)).expect(200);
    await verify(lastCode()).expect(401); // un solo uso
  });

  it('una clave incorrecta no envía ningún código', async () => {
    await enableFor(ana);
    sent.length = 0;
    await login('ana@x.co', 'incorrecta-123456').expect(401);
    expect(sent).toHaveLength(0);
  });

  it('cinco intentos fallidos inutilizan el código, incluso el correcto', async () => {
    await enableFor(ana);
    const first = await login('ana@x.co').expect(200);
    const real = lastCode();
    const verify = (code: string) =>
      request(srv()).post('/auth/login/verify').send({ challengeId: first.body.challengeId, code });
    for (let i = 0; i < 5; i++) await verify('999999').expect(401);
    await verify(real).expect(401);
    // hay que empezar de nuevo con la clave, y llega un código nuevo
    const second = await login('ana@x.co').expect(200);
    expect(second.body.challengeId).not.toBe(first.body.challengeId);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: second.body.challengeId, code: lastCode() })
      .expect(200);
  });

  it('el código vence y un reto nuevo anula el anterior', async () => {
    await enableFor(ana);
    const first = await login('ana@x.co').expect(200);
    const oldCode = lastCode();
    const second = await login('ana@x.co').expect(200);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: first.body.challengeId, code: oldCode })
      .expect(401);
    await db
      .update(twoFactorChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(twoFactorChallenges.id, second.body.challengeId));
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: second.body.challengeId, code: lastCode() })
      .expect(401);
  });

  it('un código de otro propósito o de otra cuenta no sirve', async () => {
    const bob = await person('200', 'bob@x.co');
    await enableFor(ana);
    // reto de ACTIVACIÓN de Bob usado como ingreso
    const start = await call(bob, 'post', '/me/two-factor/start').expect(200);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: start.body.challengeId, code: lastCode() })
      .expect(401);
    // reto de INGRESO de Ana usado para activar el doble paso de Bob
    const loginAna = await login('ana@x.co').expect(200);
    await call(bob, 'post', '/me/two-factor/confirm', {
      challengeId: loginAna.body.challengeId,
      code: lastCode(),
    }).expect(400);
    expect((await call(bob, 'get', '/me/two-factor').expect(200)).body.enabled).toBe(false);
    // datos mal formados
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: 'no-es-uuid', code: '123456' })
      .expect(400);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: loginAna.body.challengeId })
      .expect(400);
  });

  it('si el correo no se puede enviar, no se abre sesión', async () => {
    await enableFor(ana);
    failMail = true;
    const res = await login('ana@x.co').expect(401);
    expect(cookieOf(res)).toBe('');
    failMail = false;
    // activarlo sin poder enviar el código también falla de forma clara
    const bob = await person('200', 'bob@x.co');
    failMail = true;
    await call(bob, 'post', '/me/two-factor/start').expect(502);
  });

  it('limita los códigos por hora', async () => {
    await enableFor(ana);
    for (let i = 0; i < 5; i++) await login('ana@x.co').expect(200);
    await login('ana@x.co').expect(401); // el sexto no recibe código ni sesión
    const bob = await person('200', 'bob@x.co');
    for (let i = 0; i < 3; i++) await call(bob, 'post', '/me/two-factor/start').expect(200);
    await call(bob, 'post', '/me/two-factor/start').expect(429);
  });

  it('si la cuenta se bloquea entre los dos pasos, no entra', async () => {
    await enableFor(ana);
    const first = await login('ana@x.co').expect(200);
    await db.update(accounts).set({ status: 'BLOQUEADA' }).where(eq(accounts.id, ana.id));
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: first.body.challengeId, code: lastCode() })
      .expect(401);
  });

  it('desactivarlo exige la clave; después el ingreso vuelve a ser normal', async () => {
    await enableFor(ana);
    const s = await sessionOfWithCode(ana);
    await call(s, 'post', '/me/two-factor/disable', { password: 'incorrecta-123456' }).expect(401);
    expect((await call(s, 'get', '/me/two-factor').expect(200)).body.enabled).toBe(true);
    await call(s, 'post', '/me/two-factor/disable', { password: PASSWORD }).expect(200);
    await call(s, 'post', '/me/two-factor/disable', { password: PASSWORD }).expect(409);
    const res = await login('ana@x.co').expect(200);
    expect(res.body.twoFactorRequired).toBeUndefined();
  });

  async function sessionOfWithCode(a: Sess): Promise<Sess> {
    const first = await login('ana@x.co').expect(200);
    const ok = await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: first.body.challengeId, code: lastCode() })
      .expect(200);
    return { cookie: cookieOf(ok), csrf: ok.body.csrfToken as string, id: a.id };
  }

  it('el administrador ve el estado y puede desactivarlo por recuperación; los demás no', async () => {
    await enableFor(ana);
    const state = (await call(adm, 'get', '/admin/accounts/by-employee/100').expect(200)).body;
    expect(state).toMatchObject({
      exists: true,
      username: 'ana@x.co',
      status: 'ACTIVA',
      twoFactorEnabled: true,
    });
    await call(ana, 'get', '/admin/accounts/by-employee/100').expect(403);
    await call(ana, 'post', `/admin/accounts/${ana.id}/two-factor/disable`).expect(403);
    await call(adm, 'post', `/admin/accounts/${adm.id}/two-factor/disable`).expect(403); // no la propia
    await call(adm, 'post', `/admin/accounts/${ana.id}/two-factor/disable`).expect(200);
    await call(adm, 'post', `/admin/accounts/${ana.id}/two-factor/disable`).expect(409);
    expect(
      (await call(adm, 'get', '/admin/accounts/by-employee/100').expect(200)).body.twoFactorEnabled,
    ).toBe(false);
    const res = await login('ana@x.co').expect(200);
    expect(res.body.twoFactorRequired).toBeUndefined();
    const actions = (await db.select().from(auditLogs)).map((l) => l.action);
    expect(actions).toContain('TWO_FACTOR_DISABLE_ADMIN');
    expect(JSON.stringify(await db.select().from(auditLogs))).not.toMatch(
      /\b\d{6}\b(?=.*TWO_FACTOR)/,
    );
  });
});
