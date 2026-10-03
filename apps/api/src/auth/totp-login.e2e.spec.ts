import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, accountTotp, employeeSnapshots, twoFactorChallenges } from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { open } from '../security/secret-box';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string; id: string };

describe.skipIf(!url)('doble paso con app autenticadora (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  const sent: string[] = [];
  const mailer: Mailer = {
    send: (_to, _subject, text) => {
      sent.push(text);
      return Promise.resolve();
    },
  };
  let ana: Sess;

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

  const login = () =>
    request(srv()).post('/auth/login').send({ email: 'ana@x.co', password: PASSWORD });
  const cookieOf = (res: request.Response) =>
    String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const call = (s: Sess, method: 'get' | 'post', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };
  async function appCode(offsetSteps = 0) {
    const [row] = await db.select().from(accountTotp);
    const t = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: open(row?.secretSealed ?? ''),
    });
    return t.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
  }
  async function enableTotp(): Promise<string[]> {
    const start = await call(ana, 'post', '/me/two-factor/totp/start').expect(200);
    expect(start.headers['cache-control']).toContain('no-store');
    expect(start.body.qrDataUrl).toMatch(/^data:image\/png/);
    const done = await call(ana, 'post', '/me/two-factor/totp/confirm', {
      code: await appCode(),
    }).expect(200);
    expect(done.body).toMatchObject({ enabled: true, method: 'TOTP', recoveryCodesLeft: 10 });
    return done.body.recoveryCodes as string[];
  }

  beforeEach(async () => {
    sent.length = 0;
    await db.execute(
      sql`TRUNCATE two_factor_challenges, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '100', nCont: '1', email: 'ana@x.co', est: 'V', nombre: 'Ana' });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: '100',
        email: 'ana@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    const res = await login().expect(200);
    ana = { cookie: cookieOf(res), csrf: res.body.csrfToken as string, id: a?.id ?? '' };
  });

  it('activar TOTP, ingresar con el código de la app y no enviar correo', async () => {
    await enableTotp();
    sent.length = 0;
    const res = await login().expect(200);
    expect(res.body).toMatchObject({ twoFactorRequired: true, method: 'TOTP' });
    expect(cookieOf(res)).not.toContain('nf_session');
    expect(sent).toHaveLength(0);

    // El código del paso actual ya se usó al activar; el del siguiente paso sirve una vez.
    const code = await appCode(1);
    const ok = await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: res.body.challengeId, code })
      .expect(200);
    expect(cookieOf(ok)).toContain('nf_session');
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: res.body.challengeId, code })
      .expect(401);
  });

  it('un código de respaldo abre la sesión una sola vez', async () => {
    const [rc] = await enableTotp();
    const first = await login().expect(200);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: first.body.challengeId, code: rc })
      .expect(200);
    const second = await login().expect(200);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: second.body.challengeId, code: rc })
      .expect(401);
  });

  it('tras 5 intentos fallidos el reto deja de servir aunque luego llegue el código bueno', async () => {
    await enableTotp();
    const r = await login().expect(200);
    for (let i = 0; i < 5; i++)
      await request(srv())
        .post('/auth/login/verify')
        .send({ challengeId: r.body.challengeId, code: '000000' })
        .expect(401);
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: r.body.challengeId, code: await appCode(1) })
      .expect(401);
  });

  it('un reto vencido no sirve', async () => {
    await enableTotp();
    const r = await login().expect(200);
    await db
      .update(twoFactorChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(twoFactorChallenges.id, r.body.challengeId));
    await request(srv())
      .post('/auth/login/verify')
      .send({ challengeId: r.body.challengeId, code: await appCode(1) })
      .expect(401);
  });

  it('el estado expone método y códigos restantes; desactivar vuelve al correo', async () => {
    const [rc] = await enableTotp();
    expect((await call(ana, 'get', '/me/two-factor').expect(200)).body).toMatchObject({
      enabled: true,
      method: 'TOTP',
      recoveryCodesLeft: 10,
    });
    await call(ana, 'post', '/me/two-factor/totp/disable', { password: 'mala', code: rc }).expect(
      401,
    );
    const off = await call(ana, 'post', '/me/two-factor/totp/disable', {
      password: PASSWORD,
      code: rc,
    }).expect(200);
    expect(off.body).toMatchObject({ enabled: true, method: 'EMAIL', recoveryCodesLeft: 0 });
    const r = await login().expect(200);
    expect(r.body).toMatchObject({ twoFactorRequired: true, method: 'EMAIL' });
    expect(sent).toHaveLength(1);
  });

  it('regenerar códigos de respaldo exige clave y código, y devuelve 10 nuevos', async () => {
    const [rc, rc2] = await enableTotp();
    await call(ana, 'post', '/me/two-factor/totp/recovery-codes', {
      password: PASSWORD,
      code: '000000',
    }).expect(400);
    const res = await call(ana, 'post', '/me/two-factor/totp/recovery-codes', {
      password: PASSWORD,
      code: rc,
    }).expect(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.recoveryCodes).not.toContain(rc2);
  });

  it('no se puede iniciar el alta de TOTP dos veces estando activo, y confirmar sin iniciar da 409', async () => {
    await call(ana, 'post', '/me/two-factor/totp/confirm', { code: '123456' }).expect(409);
    await enableTotp();
    await call(ana, 'post', '/me/two-factor/totp/start').expect(409);
  });
});
