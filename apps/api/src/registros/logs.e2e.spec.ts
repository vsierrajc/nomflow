import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
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
  archiveSettings,
  auditLogs,
  employeeSnapshots,
  logArchives,
  roleAssignments,
} from '../db/schema';
import { seal } from '../security/secret-box';
import { COLD_STORE_FACTORY, type DbColdStoreProvider } from '../storage/archive-settings.service';
import { MemoryObjectStore } from '../storage/memory-object-store';
import { COLD_PROVIDER } from '../storage/storage.module';
import { configuredFiles, validLogSettings } from './logs.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const DAY = 86_400_000;
type Sess = { cookie: string; csrf: string };

/** «Nube» de pruebas que puede corromper lo que recibe. */
class FakeCloud extends MemoryObjectStore {
  corrupt = false;
  override put(key: string, data: Buffer, contentType?: string) {
    const d = Buffer.from(data);
    if (this.corrupt && d.length > 0) d[d.length - 1] = (d[d.length - 1] ?? 0) ^ 0xff;
    return super.put(key, d, contentType);
  }
}

describe('ajustes y archivos configurados', () => {
  it('valida la política', () => {
    const ok = {
      retentionDays: 365,
      httpRetentionDays: 90,
      archiveBeforePurge: true,
      autoEnabled: false,
    };
    expect(validLogSettings(ok)).toBe(true);
    expect(validLogSettings({ ...ok, retentionDays: 10 })).toBe(false);
    expect(validLogSettings({ ...ok, httpRetentionDays: 1 })).toBe(false);
  });
  it('solo acepta nombres sencillos de LOG_FILES', () => {
    const f = configuredFiles({
      LOG_FILES: 'api=/x/api.log, web=/x/web.log,../mal=/etc/passwd,sin-ruta=,otro',
    });
    expect(f.map((x) => x.name)).toEqual(['api', 'web']);
  });
});

describe.skipIf(!url)('gestión de registros (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  const cloud = new FakeCloud();
  let app: INestApplication;
  let adm: Sess;
  let emp: Sess;
  let dir = '';
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    process.env.OBJECT_ENCRYPTION_KEY = 'clave-de-objetos-de-prueba-con-mas-de-32-caracteres';
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(COLD_STORE_FACTORY)
      .useValue(() => cloud)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    delete process.env.LOG_FILES;
    await app.close();
    await ctx.pool.end();
  });

  async function person(key: string, admin = false) {
    const email = `${key.toLowerCase()}@x.co`;
    await db
      .insert(employeeSnapshots)
      .values({ nIde: key, nCont: '1', email, est: 'V', nombre: `PERSONA ${key}` });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: key,
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
        .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
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
    const agent = request(srv());
    const r = agent[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(d);
  const row = (action: string, at: Date) => ({
    action,
    resource: 'x',
    result: 'SUCCESS',
    at,
    context: { n: 1 },
  });
  /** Filas sembradas por la prueba (resource = 'x'): las peticiones de la propia prueba también se auditan y no cuentan. */
  const count = async (q = sql`true`) =>
    Number(
      (
        await db.execute<{ n: string }>(
          sql`select count(*) n from audit_logs where resource = 'x' and ${q}`,
        )
      ).rows[0]?.n,
    );
  const countAll = async (q = sql`true`) =>
    Number(
      (await db.execute<{ n: string }>(sql`select count(*) n from audit_logs where ${q}`)).rows[0]
        ?.n,
    );
  const bin = (r: request.Response) => Buffer.from(r.body as Buffer);
  const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const provider = () => app.get<DbColdStoreProvider>(COLD_PROVIDER);
  const cold = async () => {
    await db.delete(archiveSettings);
    await db.insert(archiveSettings).values({
      id: 1,
      enabled: false,
      accessKeyId: 'AK',
      secretEnc: seal('SECRETO'),
      bucket: 'nomflow',
    });
    provider().invalidate();
  };
  const purgeBody = (over: object = {}) => ({
    before: day(ago(30)),
    kind: 'TODO',
    archive: true,
    reason: 'Depuración de prueba de registros',
    confirm: 'BORRAR',
    ...over,
  });

  beforeEach(async () => {
    cloud.objects.clear();
    cloud.down = false;
    cloud.corrupt = false;
    await db.execute(
      sql`TRUNCATE log_archives, log_settings, archive_settings, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    adm = await person('ADM', true);
    emp = await person('EMP');
    await db.delete(auditLogs); // los de los ingresos de arriba: se parte de cero
    provider().invalidate();
    await db.insert(auditLogs).values([
      row('HTTP_REQUEST', ago(200)),
      row('HTTP_REQUEST', ago(120)),
      row('HTTP_REQUEST', ago(10)),
      row('LOGIN', ago(400)),
      row('LOGIN', ago(50)),
      row('ACCOUNT_CREATE', ago(3)),
      row('AUDIT_PURGE', ago(500)), // huella de una depuración anterior: nunca se borra
    ]);
    dir = mkdtempSync(join(tmpdir(), 'nf-logs-'));
    writeFileSync(
      join(dir, 'api.log'),
      ['linea uno', 'ERROR algo falló', 'linea tres', 'otro ERROR más'].join('\n') + '\n',
    );
    process.env.LOG_FILES = `api=${join(dir, 'api.log')},web=${join(dir, 'no-existe.log')}`;
  });

  it('solo administradores', async () => {
    for (const [m, p] of [
      ['get', '/admin/logs'],
      ['get', '/admin/logs/archives'],
      ['get', '/admin/logs/audit/export'],
      ['get', '/admin/logs/files/api/tail'],
    ] as const)
      await call(emp, m, p).expect(403);
    await call(emp, 'post', '/admin/logs/audit/purge', purgeBody({ archive: false })).expect(403);
    await request(srv()).get('/admin/logs').expect(401);
  });

  it('resumen: totales por tipo, fechas, meses, archivos y política', async () => {
    const s = (await call(adm, 'get', '/admin/logs').expect(200)).body;
    expect(s.audit.total).toBeGreaterThanOrEqual(7);
    expect(s.audit.http).toBeGreaterThanOrEqual(3);
    expect(s.audit.total).toBe(s.audit.http + s.audit.events);
    expect(new Date(s.audit.oldest).getTime()).toBeLessThan(Date.now() - 400 * DAY);
    expect(s.audit.months.length).toBeGreaterThan(0);
    expect(s.files.map((f: { name: string }) => f.name)).toEqual(['api', 'web']);
    expect(s.files[0].size).toBeGreaterThan(0);
    expect(s.settings).toMatchObject({
      retentionDays: 365,
      httpRetentionDays: 90,
      archiveBeforePurge: true,
      autoEnabled: false,
    });
    expect(s.coldConfigured).toBe(false);
  });

  it('exporta en CSV y JSONL con filtros y lo deja auditado', async () => {
    const csv = await call(adm, 'get', '/admin/logs/audit/export?kind=EVENTOS&format=csv').expect(
      200,
    );
    expect(csv.headers['content-disposition']).toContain('.csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('fecha,accion,recurso,id_recurso,resultado,usuario,contexto');
    expect(lines.filter((l) => l.includes(',x,')).length).toBe(4); // los 4 eventos sembrados
    expect(csv.text).not.toContain('HTTP_REQUEST');
    const jsonl = await call(
      adm,
      'get',
      `/admin/logs/audit/export?kind=HTTP&format=jsonl&from=${day(ago(150))}`,
    ).expect(200);
    const rows = jsonl.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { at: string; action: string; resource: string })
      .filter((r) => r.resource === 'x');
    expect(rows).toHaveLength(2); // los de hace 120 y 10 días
    expect(rows.every((r) => r.action === 'HTTP_REQUEST')).toBe(true);
    const ordered = rows.map((r) => r.at);
    expect([...ordered].sort()).toEqual(ordered);
    await call(adm, 'get', '/admin/logs/audit/export?format=xml').expect(400);
    expect(await countAll(sql`action = 'LOG_EXPORT'`)).toBe(2);
  });

  it('envía un rango al histórico cifrado, lo verifica y se puede descargar; no borra nada', async () => {
    await call(adm, 'post', '/admin/logs/audit/archive', { kind: 'TODO' }).expect(409); // sin nube configurada
    await cold();
    const before = await count();
    const res = await call(adm, 'post', '/admin/logs/audit/archive', {
      kind: 'HTTP',
      from: day(ago(400)),
      to: day(ago(5)),
    }).expect(200);
    expect(res.body.archived).toBeGreaterThanOrEqual(2);
    expect(await count()).toBe(before); // copiar no borra
    const all = await db.select().from(logArchives);
    expect(all.length).toBeGreaterThanOrEqual(2); // un archivo por mes cubierto
    expect(
      all.every((a) => a.source === 'AUDITORIA' && a.kind === 'HTTP' && a.purgedCount === 0),
    ).toBe(true);
    let seeded = 0;
    for (const a of all) {
      const stored = cloud.objects.get(a.objectKey);
      expect(stored?.data.subarray(0, 3).toString()).toBe('NF1'); // en la nube solo hay bytes cifrados
      expect(stored?.data.includes(Buffer.from('HTTP_REQUEST'))).toBe(false);
      const dl = await call(adm, 'get', `/admin/logs/archives/${a.id}/download`)
        .buffer(true)
        .parse(binary)
        .expect(200);
      const text = gunzipSync(bin(dl))
        .toString('utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { action: string; resource: string });
      expect(text).toHaveLength(a.rowCount);
      expect(text.every((r) => r.action === 'HTTP_REQUEST')).toBe(true);
      seeded += text.filter((r) => r.resource === 'x').length;
    }
    expect(seeded).toBe(3); // hace 200, 120 y 10 días
    expect((await call(adm, 'get', '/admin/logs/archives').expect(200)).body.archives).toHaveLength(
      all.length,
    );
    await call(
      adm,
      'get',
      '/admin/logs/archives/00000000-0000-4000-8000-000000000000/download',
    ).expect(404);
  });

  it('depurar archivando primero: borra solo lo copiado y verificado, respeta lo reciente y deja su huella', async () => {
    await cold();
    const res = await call(adm, 'post', '/admin/logs/audit/purge', purgeBody()).expect(200);
    // hace 200 y 120 (HTTP) y 400 y 50 (LOGIN): 4; el AUDIT_PURGE de hace 500 días se conserva
    expect(res.body).toMatchObject({ deleted: 4, archived: 4 });
    expect(await count(sql`action = 'HTTP_REQUEST'`)).toBe(1); // solo la de hace 10 días
    expect(await count(sql`action = 'LOGIN'`)).toBe(0);
    expect(await count(sql`action = 'AUDIT_PURGE'`)).toBe(1);
    expect(await count(sql`action = 'ACCOUNT_CREATE'`)).toBe(1);
    const rows = await db.select().from(logArchives);
    expect(rows.reduce((n, r) => n + r.rowCount, 0)).toBe(4);
    expect(rows.reduce((n, r) => n + r.purgedCount, 0)).toBe(4);
    const [p] = await db.select().from(auditLogs).where(eq(auditLogs.resource, 'logs'));
    expect(p).toMatchObject({ action: 'AUDIT_PURGE' });
    expect(p?.context).toMatchObject({ deleted: 4, archived: 4, withArchive: true });
  });

  it('sin respaldo: exige confirmación y motivo, filtra por tipo y conserva las huellas', async () => {
    const body = purgeBody({
      before: day(ago(100)),
      kind: 'HTTP',
      archive: false,
      reason: 'Limpieza de peticiones antiguas',
    });
    await call(adm, 'post', '/admin/logs/audit/purge', { ...body, confirm: 'borrar' }).expect(400);
    await call(adm, 'post', '/admin/logs/audit/purge', { ...body, reason: 'corto' }).expect(400);
    await call(adm, 'post', '/admin/logs/audit/purge', { ...body, before: 'ayer' }).expect(400);
    expect(await count()).toBe(7); // nada se borró con peticiones inválidas
    const r = await call(adm, 'post', '/admin/logs/audit/purge', body).expect(200);
    expect(r.body).toMatchObject({ deleted: 2, archived: 0 }); // las HTTP de hace 200 y 120 días
    expect(await count(sql`action = 'LOGIN'`)).toBe(2); // los eventos no se tocan al depurar solo HTTP
    const [p] = await db.select().from(auditLogs).where(eq(auditLogs.resource, 'logs'));
    expect(p?.context).toMatchObject({
      kind: 'HTTP',
      deleted: 2,
      withArchive: false,
      reason: 'Limpieza de peticiones antiguas',
    });
    // borrar todo: incluso los eventos, pero sobreviven las huellas de las depuraciones
    await call(adm, 'post', '/admin/logs/audit/purge', {
      ...body,
      before: day(new Date(Date.now() + DAY)),
      kind: 'TODO',
    }).expect(200);
    expect(await count()).toBe(1); // de lo sembrado solo queda la huella de una depuración anterior
    expect(await count(sql`action = 'AUDIT_PURGE'`)).toBe(1);
    expect(await countAll(sql`action = 'AUDIT_PURGE'`)).toBeGreaterThanOrEqual(3); // y las de estas dos depuraciones
  });

  it('si la copia no se puede verificar, no se borra nada', async () => {
    await cold();
    cloud.corrupt = true;
    const r = await call(adm, 'post', '/admin/logs/audit/purge', purgeBody()).expect(502);
    expect(r.body.code).toBe('ARCHIVE_FAILED');
    expect(await count()).toBe(7);
    cloud.corrupt = false;
    cloud.down = true;
    await call(adm, 'post', '/admin/logs/audit/purge', purgeBody()).expect(502);
    expect(await count()).toBe(7);
    // sin nube configurada: con copia previa se rechaza
    await db.delete(archiveSettings);
    provider().invalidate();
    cloud.down = false;
    await call(adm, 'post', '/admin/logs/audit/purge', purgeBody()).expect(409);
    expect(await count()).toBe(7);
  });

  it('política: se valida, se guarda y el mantenimiento aplica la retención de cada tipo', async () => {
    await call(adm, 'put', '/admin/logs/settings', {
      retentionDays: 5,
      httpRetentionDays: 90,
      archiveBeforePurge: true,
      autoEnabled: false,
    }).expect(400);
    const s = await call(adm, 'put', '/admin/logs/settings', {
      retentionDays: 100,
      httpRetentionDays: 60,
      archiveBeforePurge: false,
      autoEnabled: true,
    }).expect(200);
    expect(s.body).toMatchObject({
      retentionDays: 100,
      httpRetentionDays: 60,
      archiveBeforePurge: false,
      autoEnabled: true,
    });
    const r = await call(adm, 'post', '/admin/logs/maintenance/run').expect(200);
    // HTTP > 60 días: hace 200 y 120 (2). Eventos > 100 días: LOGIN de hace 400 (1). AUDIT_PURGE se conserva.
    expect(r.body.purged).toBeGreaterThanOrEqual(3);
    expect(r.body.archived).toBe(0);
    expect(await count(sql`action = 'HTTP_REQUEST'`)).toBe(1);
    expect(await count(sql`action = 'LOGIN'`)).toBe(1);
    expect((await call(adm, 'get', '/admin/logs').expect(200)).body.settings).toMatchObject({
      lastRunStatus: 'OK',
    });
  });

  it('archivos de la aplicación: ver las últimas líneas con filtro, descargar, enviar a la nube y vaciar', async () => {
    const t = (await call(adm, 'get', '/admin/logs/files/api/tail?lines=10').expect(200)).body;
    expect(t.lines).toEqual(['linea uno', 'ERROR algo falló', 'linea tres', 'otro ERROR más']);
    expect(
      (await call(adm, 'get', '/admin/logs/files/api/tail?q=error').expect(200)).body.lines,
    ).toEqual(['ERROR algo falló', 'otro ERROR más']);
    expect((await call(adm, 'get', '/admin/logs/files/web/tail').expect(200)).body).toMatchObject({
      lines: [],
      size: 0,
    }); // no existe aún
    await call(adm, 'get', '/admin/logs/files/otro/tail').expect(404); // solo los configurados
    await call(adm, 'get', '/admin/logs/files/..%2Fetc%2Fpasswd/tail').expect(404);
    const d = await call(adm, 'get', '/admin/logs/files/api/download')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(d.headers['content-disposition']).toContain('api.log');
    expect(bin(d).toString()).toContain('ERROR algo falló');
    await call(adm, 'post', '/admin/logs/files/api/archive').expect(409); // sin nube
    await cold();
    await call(adm, 'post', '/admin/logs/files/api/archive').expect(200);
    const [a] = await db.select().from(logArchives);
    expect(a).toMatchObject({ source: 'API', purgedCount: 0 });
    const back = await call(adm, 'get', `/admin/logs/archives/${a?.id}/download`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(gunzipSync(bin(back)).toString()).toContain('linea tres');
    // vaciar: exige confirmación y motivo; con archiveFirst hace copia antes
    const body = { archiveFirst: true, reason: 'Vaciar el registro de la API', confirm: 'BORRAR' };
    await call(adm, 'post', '/admin/logs/files/api/truncate', { ...body, confirm: 'si' }).expect(
      400,
    );
    expect(readFileSync(join(dir, 'api.log'), 'utf8')).toContain('linea uno');
    const r = await call(adm, 'post', '/admin/logs/files/api/truncate', body).expect(200);
    expect(r.body.cleared).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'api.log'), 'utf8')).toBe('');
    expect(await db.select().from(logArchives)).toHaveLength(2); // la de antes y la previa al vaciado
    expect(await countAll(sql`action = 'LOG_FILE_TRUNCATE'`)).toBe(1);
    await call(adm, 'post', '/admin/logs/files/otro/truncate', body).expect(404);
  });
});
