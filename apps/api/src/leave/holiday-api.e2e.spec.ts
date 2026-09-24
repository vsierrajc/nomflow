import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  employeeSnapshots,
  holidayApiSettings,
  holidayCalendars,
  roleAssignments,
} from '../db/schema';
import { open, seal } from './secret-box';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const KEY = 'clave-secreta-del-servicio-XYZ';
type Sess = { cookie: string; csrf: string };

describe('secret-box', () => {
  it('cifra y descifra, y no deja el texto en claro', () => {
    process.env.SESSION_SECRET ??= 'x'.repeat(40);
    const sealed = seal(KEY);
    expect(sealed).not.toContain(KEY);
    expect(open(sealed)).toBe(KEY);
    expect(seal(KEY)).not.toBe(sealed); // iv aleatorio
    expect(() => open(sealed.replace(/.$/, 'A'))).toThrow();
  });
});

describe.skipIf(!url)('API de festivos: configuración y sincronización (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let mock: Server;
  let base = '';
  let hr: Sess;
  let emp: Sess;
  let mode: 'ok' | '401' | '429' | '500' | 'bad' | 'redirect' | 'empty' = 'ok';
  let seen: { auth: string | undefined; url: string | undefined }[] = [];
  let days: { date: string; name_es: string }[] = [];
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    await runMigrations(url ?? '');
    mock = createServer((req: IncomingMessage, res) => {
      seen.push({ auth: req.headers.authorization, url: req.url });
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (mode === '401') return json(401, { error: 'no autorizado' });
      if (mode === '429') return json(429, { error: 'límite' });
      if (mode === '500') return json(500, {});
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/otro' });
        return res.end();
      }
      if (mode === 'empty') return json(200, { data: [] });
      if (mode === 'bad') return json(200, { data: [{ date: '2099-01-01', name_es: 'Otro año' }] });
      return json(200, { data: days });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/api/v1/festivos`;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => mock.close(() => r()));
    await ctx.pool.end();
  });

  async function person(nIde: string, email: string, role?: 'HR_ADMIN'): Promise<Sess> {
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
    if (role)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role, validFrom: '2020-01-01' });
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  const call = (s: Sess, method: 'get' | 'put' | 'post', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };
  const settings = () => call(hr, 'get', '/admin/holiday-api').expect(200);
  const configure = (extra: object = {}) =>
    call(hr, 'put', '/admin/holiday-api', { url: base, apiKey: KEY, ...extra });

  beforeEach(async () => {
    mode = 'ok';
    seen = [];
    days = [
      { date: '2031-01-01', name_es: 'Año Nuevo' },
      { date: '2031-05-01', name_es: 'Día del Trabajo' },
    ];
    await db.execute(
      sql`TRUNCATE holiday_api_settings, holidays, holiday_calendars, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    hr = await person('ADM', 'adm@x.co', 'HR_ADMIN');
    emp = await person('100', 'e@x.co');
  });

  it('guarda la URL y la clave cifrada, y nunca devuelve la clave', async () => {
    expect((await settings()).body).toMatchObject({ configured: false, hasApiKey: false });
    for (const bad of ['ftp://x.co/a', 'no es url', 'https://u:p@x.co/a', `${base}?year=2031`])
      await call(hr, 'put', '/admin/holiday-api', { url: bad, apiKey: KEY }).expect(400);
    const saved = await configure().expect(200);
    expect(saved.body).toMatchObject({ configured: true, url: base, hasApiKey: true });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(JSON.stringify((await settings()).body)).not.toContain(KEY);
    const [row] = await db.select().from(holidayApiSettings);
    expect(row?.apiKeyEnc).toBeTruthy();
    expect(row?.apiKeyEnc).not.toContain(KEY);
    const logs = JSON.stringify(await db.select().from(auditLogs));
    expect(logs).not.toContain(KEY);
    expect(logs).toContain('HOLIDAY_API_CONFIG');
  });

  it('cambiar solo la URL conserva la clave; se puede borrar', async () => {
    await configure().expect(200);
    await call(hr, 'put', '/admin/holiday-api', { url: `${base}/` }).expect(200);
    expect((await settings()).body.hasApiKey).toBe(true);
    await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(200);
    await call(hr, 'put', '/admin/holiday-api', { url: base, clearApiKey: true }).expect(200);
    expect((await settings()).body.hasApiKey).toBe(false);
    await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(400);
  });

  it('sincroniza: envía la clave como Bearer, crea un borrador y no toca lo publicado', async () => {
    await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(400); // sin configurar
    await configure().expect(200);
    await call(hr, 'post', '/admin/holiday-api/sync', { year: 1999 }).expect(400);
    const res = await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(200);
    expect(res.body).toMatchObject({
      year: 2031,
      version: 1,
      days: 2,
      hadPublished: false,
      added: ['2031-01-01', '2031-05-01'],
      removed: [],
    });
    expect(seen).toEqual([{ auth: `Bearer ${KEY}`, url: '/api/v1/festivos?year=2031' }]);
    const [cal] = await db.select().from(holidayCalendars);
    expect(cal).toMatchObject({ status: 'BORRADOR', source: 'API', year: 2031 });
    expect((await settings()).body).toMatchObject({ lastSyncStatus: 'OK', lastSyncYear: 2031 });
  });

  it('compara con el calendario publicado y no lo altera', async () => {
    await configure().expect(200);
    const first = await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(200);
    await call(hr, 'post', `/admin/holidays/${first.body.id}/publish`).expect(200);
    days = [
      { date: '2031-01-01', name_es: 'Año Nuevo' },
      { date: '2031-03-24', name_es: 'San José' },
    ];
    const res = await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(200);
    expect(res.body).toMatchObject({
      version: 2,
      hadPublished: true,
      added: ['2031-03-24'],
      removed: ['2031-05-01'],
    });
    const cals = await db.select().from(holidayCalendars).orderBy(holidayCalendars.version);
    expect(cals.map((c) => c.status)).toEqual(['PUBLICADO', 'BORRADOR']);
  });

  it('errores del servicio: se informa, se registra y se conserva lo publicado', async () => {
    await configure().expect(200);
    const published = await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(200);
    await call(hr, 'post', `/admin/holidays/${published.body.id}/publish`).expect(200);
    for (const [m, code] of [
      ['401', 'API_KEY_INVALID'],
      ['429', 'RATE_LIMITED'],
      ['500', 'UNAVAILABLE'],
      ['redirect', 'UNAVAILABLE'],
      ['bad', 'INVALID_RESPONSE'],
      ['empty', 'INVALID_RESPONSE'],
    ] as const) {
      mode = m;
      const res = await call(hr, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(502);
      expect(res.body.code, m).toBe(code);
      expect((await settings()).body.lastSyncStatus, m).toBe(code);
    }
    const cals = await db.select().from(holidayCalendars);
    expect(cals).toHaveLength(1); // ningún borrador nuevo ni cambios en el publicado
    expect(cals[0]?.status).toBe('PUBLICADO');
  });

  it('solo administradores configuran y sincronizan', async () => {
    await call(emp, 'get', '/admin/holiday-api').expect(403);
    await call(emp, 'put', '/admin/holiday-api', { url: base, apiKey: KEY }).expect(403);
    await call(emp, 'post', '/admin/holiday-api/sync', { year: 2031 }).expect(403);
    await request(srv()).get('/admin/holiday-api').expect(401);
    expect(await db.select().from(holidayApiSettings)).toHaveLength(0);
  });
});
