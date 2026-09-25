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
  healthAlerts,
  mailSettings,
  roleAssignments,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { OBJECT_STORE, ObjectStoreError, type ObjectStore } from '../storage/object-store';
import { SPACE_PROBE } from './health.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };

describe.skipIf(!url)('salud del sistema (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  const sent: { to: string; subject: string }[] = [];
  const mailer: Mailer = {
    send: (to, subject) => {
      sent.push({ to, subject });
      return Promise.resolve();
    },
  };
  // Estado controlable del "servidor" de objetos y de su espacio.
  const world = { total: 1000, available: 900, storageDown: false, probeFails: false };
  const store: ObjectStore = {
    put: () => Promise.resolve(),
    get: () =>
      world.storageDown
        ? Promise.reject(new ObjectStoreError('UNAVAILABLE'))
        : Promise.resolve(null),
  };
  const probe = () =>
    world.probeFails
      ? Promise.reject(new Error('HTTP_500'))
      : Promise.resolve([{ available: world.available, total: world.total }]);
  let adm: Sess;
  let plain: Sess;

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(OBJECT_STORE)
      .useValue(store)
      .overrideProvider(SPACE_PROBE)
      .useValue(probe)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  async function person(nIde: string, email: string, admin?: 'HR_ADMIN' | 'SYSTEM_ADMIN') {
    await db.insert(employeeSnapshots).values({ nIde, nCont: '1', email, est: 'V', nombre: nIde });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: accounts.id });
    if (admin)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role: admin, validFrom: '2020-01-01' });
    return a?.id ?? '';
  }
  async function sessionOf(email: string): Promise<Sess> {
    const res = await request(srv())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  const call = (s: Sess, method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };
  const check = () => call(adm, 'post', '/admin/health/check').expect(200);
  const level = (b: { checks: { key: string; level: string }[] }, key: string) =>
    b.checks.find((c) => c.key === key)?.level;

  beforeEach(async () => {
    sent.length = 0;
    Object.assign(world, { total: 1000, available: 900, storageDown: false, probeFails: false });
    await db.execute(
      sql`TRUNCATE health_alerts, health_settings, audit_logs, sessions, role_assignments, accounts, employee_snapshots, mail_settings CASCADE`,
    );
    await db
      .insert(mailSettings)
      .values({ host: 'smtp.x.co', port: 25, fromEmail: 'nomflow@x.co' });
    await person('ADM', 'adm@x.co', 'HR_ADMIN');
    await person('SYS', 'sys@x.co', 'SYSTEM_ADMIN');
    await person('EMP', 'emp@x.co');
    adm = await sessionOf('adm@x.co');
    plain = await sessionOf('emp@x.co');
  });

  it('solo administradores; sin sesión no entra', async () => {
    await request(srv()).get('/admin/health').expect(401);
    await call(plain, 'get', '/admin/health').expect(403);
    await call(plain, 'post', '/admin/health/check').expect(403);
    await call(plain, 'get', '/admin/health/alerts').expect(403);
  });

  it('todo en orden: sin alertas ni correos', async () => {
    const res = await check();
    expect(level(res.body, 'database')).toBe('OK');
    expect(level(res.body, 'storage_reachable')).toBe('OK');
    expect(level(res.body, 'storage_space')).toBe('OK');
    expect(level(res.body, 'object_errors')).toBe('OK');
    expect(await db.select().from(healthAlerts)).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const status = await call(adm, 'get', '/admin/health').expect(200);
    expect(status.body.settings.storageWarnFreePct).toBe(20);
  });

  it('poco espacio: aviso (20 %) y luego crítico (10 %), con un correo por cambio a todos los administradores', async () => {
    world.available = 150; // 15 % libre
    let res = await check();
    expect(level(res.body, 'storage_space')).toBe('WARN');
    expect(sent.map((m) => m.to).sort()).toEqual(['adm@x.co', 'sys@x.co']);
    expect(sent[0]?.subject).toContain('AVISO');
    expect(sent.every((m) => !m.to.includes('emp@'))).toBe(true);

    await check(); // sin cambios: no se repite
    expect(sent).toHaveLength(2);

    world.available = 80; // 8 %
    res = await check();
    expect(level(res.body, 'storage_space')).toBe('CRIT');
    expect(sent).toHaveLength(4);
    expect(sent[2]?.subject).toContain('CRÍTICO');
    const open = await db
      .select()
      .from(healthAlerts)
      .where(eq(healthAlerts.checkKey, 'storage_space'));
    expect(open).toHaveLength(1);
    expect(open[0]?.level).toBe('CRIT');
  });

  it('el crítico se repite solo pasado el intervalo de reenvío; al recuperarse se avisa y se cierra', async () => {
    world.available = 50;
    await check();
    expect(sent).toHaveLength(2);
    await check();
    expect(sent).toHaveLength(2);
    await db.update(healthAlerts).set({ lastNotifiedAt: new Date(Date.now() - 7 * 3600_000) });
    await check();
    expect(sent).toHaveLength(4);

    world.available = 900;
    const res = await check();
    expect(level(res.body, 'storage_space')).toBe('OK');
    expect(sent).toHaveLength(6);
    expect(sent[4]?.subject).toContain('RESUELTO');
    const [row] = await db.select().from(healthAlerts);
    expect(row?.resolvedAt).not.toBeNull();
    const hist = await call(adm, 'get', '/admin/health/alerts').expect(200);
    expect(hist.body.alerts).toHaveLength(1);
  });

  it('Garage caído es crítico; sin poder medir el espacio es aviso', async () => {
    world.storageDown = true;
    world.probeFails = true;
    const res = await check();
    expect(level(res.body, 'storage_reachable')).toBe('CRIT');
    expect(level(res.body, 'storage_space')).toBe('WARN');
    expect(sent.some((m) => m.subject.includes('CRÍTICO') && m.subject.includes('Garage'))).toBe(
      true,
    );
  });

  it('errores de descarga en la ventana: aviso con 3 y crítico con 10; los antiguos no cuentan', async () => {
    const add = (n: number, at = new Date()) =>
      db.insert(auditLogs).values(
        Array.from({ length: n }, () => ({
          action: 'TAX_CERT_DOWNLOAD',
          resource: 'tax_certificates',
          result: 'HASH_MISMATCH',
          at,
        })),
      );
    await add(20, new Date(Date.now() - 3 * 3600_000));
    expect(level((await check()).body, 'object_errors')).toBe('OK');
    await add(3);
    expect(level((await check()).body, 'object_errors')).toBe('WARN');
    await add(7);
    expect(level((await check()).body, 'object_errors')).toBe('CRIT');
  });

  it('umbrales administrables: se validan, se guardan, se auditan y cambian el resultado', async () => {
    const base = (await call(adm, 'get', '/admin/health').expect(200)).body.settings;
    for (const bad of [
      { ...base, storageCritFreePct: 30 }, // crítico ≥ aviso
      { ...base, dbWarnMs: 5000 },
      { ...base, checkIntervalMin: 0 },
      { ...base, extraRecipients: 'no-es-correo' },
      { ...base, objectErrorsWarn: 'x' },
    ])
      await call(adm, 'put', '/admin/health/settings', bad).expect(400);

    world.available = 400; // 40 % libre
    expect(level((await check()).body, 'storage_space')).toBe('OK');
    const res = await call(adm, 'put', '/admin/health/settings', {
      ...base,
      storageWarnFreePct: 60,
      storageCritFreePct: 45,
      extraRecipients: 'Ti@x.co, ti@x.co',
    }).expect(200);
    expect(res.body.storageWarnFreePct).toBe(60);
    expect(res.body.extraRecipients).toBe('ti@x.co');
    expect(level((await check()).body, 'storage_space')).toBe('CRIT');
    expect(sent.map((m) => m.to).sort()).toEqual(['adm@x.co', 'sys@x.co', 'ti@x.co']);
    const [a] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'HEALTH_SETTINGS_UPDATE'));
    expect(a?.result).toBe('SUCCESS');
    await call(plain, 'put', '/admin/health/settings', base).expect(403);
  });

  it('un fallo de correo no rompe la medición y se reintenta en el siguiente ciclo', async () => {
    const original = mailer.send;
    mailer.send = () => Promise.reject(new Error('smtp caído'));
    world.available = 50;
    const res = await check();
    expect(level(res.body, 'storage_space')).toBe('CRIT');
    const [row] = await db
      .select()
      .from(healthAlerts)
      .where(eq(healthAlerts.checkKey, 'storage_space'));
    expect(row?.lastNotifiedAt).toBeNull();
    mailer.send = original;
    await check();
    expect(sent).toHaveLength(2);
  });
});
