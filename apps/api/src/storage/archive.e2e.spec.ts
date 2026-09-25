import { createHash, randomUUID } from 'node:crypto';
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
  archivedObjects,
  archiveSettings,
  auditLogs,
  employeeSnapshots,
  roleAssignments,
  taxCertificates,
} from '../db/schema';
import { COLD_STORE_FACTORY } from './archive-settings.service';
import { MemoryObjectStore } from './memory-object-store';
import { OBJECT_STORE, ObjectStoreError, type ObjectStore } from './object-store';
import { RAW_HOT_STORE } from './storage.module';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const PDF = Buffer.from('%PDF-1.4\nCertificado historico PRUEBA 555\n%%EOF\n');
type Sess = { cookie: string; csrf: string };
const DAY = 86_400_000;

/** «Nube» de pruebas que puede corromper lo que recibe. */
class FakeCloud extends MemoryObjectStore {
  corrupt = false;
  /** Simula la respuesta de error del servicio (nombre y estado HTTP), como Google. */
  fail: { name: string; status: number | undefined } | null = null;
  override get(key: string) {
    if (this.fail) return Promise.reject(new ObjectStoreError('UNAVAILABLE', this.fail));
    return super.get(key);
  }
  override put(key: string, data: Buffer, contentType?: string) {
    if (this.fail) return Promise.reject(new ObjectStoreError('UNAVAILABLE', this.fail));
    const d = Buffer.from(data);
    if (this.corrupt && d.length > 0) d[d.length - 1] = (d[d.length - 1] ?? 0) ^ 0xff;
    return super.put(key, d, contentType);
  }
}

describe.skipIf(!url)('archivo histórico en la nube (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  const hot = new MemoryObjectStore();
  const cloud = new FakeCloud();
  let app: INestApplication;
  let store: ObjectStore;
  let adm: Sess;
  let emp: Sess;
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    process.env.OBJECT_ENCRYPTION_KEY = 'clave-de-objetos-de-prueba-con-mas-de-32-caracteres';
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAW_HOT_STORE)
      .useValue(hot)
      .overrideProvider(COLD_STORE_FACTORY)
      .useValue(() => cloud)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    store = app.get<ObjectStore>(OBJECT_STORE);
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  async function person(nIde: string, email: string, admin?: 'HR_ADMIN') {
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
  /** Certificado del empleado subido hace `daysAgo` días, guardado cifrado en local. */
  async function certificate(year: number, daysAgo: number) {
    const objectKey = `tax-certificates/${randomUUID()}.pdf`;
    await store.put(objectKey, PDF, 'application/pdf');
    await db.insert(taxCertificates).values({
      nIde: 'EMP',
      year,
      version: 1,
      objectKey,
      sha256: createHash('sha256').update(PDF).digest('hex'),
      sizeBytes: PDF.length,
      fileName: `retencion-${year}.pdf`,
      uploadedAt: new Date(Date.now() - daysAgo * DAY),
    });
    return objectKey;
  }
  const settings = (over: object = {}) => ({
    enabled: true,
    endpoint: 'https://storage.googleapis.com',
    region: 'us-central1',
    bucket: 'nomflow',
    accessKeyId: 'GOOG1EXAMPLE',
    secret: 'clave-hmac-SECRETA-123',
    ageDays: 365,
    graceDays: 0,
    ...over,
  });
  const run = () => call(adm, 'post', '/admin/archive/run');

  beforeEach(async () => {
    hot.objects.clear();
    cloud.objects.clear();
    cloud.down = false;
    cloud.corrupt = false;
    cloud.fail = null;
    await db.execute(
      sql`TRUNCATE archived_objects, archive_settings, tax_certificates, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await person('ADM', 'adm@x.co', 'HR_ADMIN');
    await person('EMP', 'emp@x.co');
    adm = await sessionOf('adm@x.co');
    emp = await sessionOf('emp@x.co');
  });

  it('solo administradores; la clave no se devuelve ni se audita', async () => {
    await call(emp, 'get', '/admin/archive').expect(403);
    await call(emp, 'post', '/admin/archive/run').expect(403);
    await request(srv()).get('/admin/archive').expect(401);
    const res = await call(adm, 'put', '/admin/archive/settings', settings()).expect(200);
    expect(res.body.settings.hasSecret).toBe(true);
    expect(res.body.settings.configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('SECRETA');
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ARCHIVE_SETTINGS_UPDATE'));
    expect(JSON.stringify(logs)).not.toContain('SECRETA');
    const [row] = await db.select().from(archiveSettings);
    expect(row?.secretEnc).toBeTruthy();
    expect(row?.secretEnc).not.toContain('SECRETA');
  });

  it('valida la configuración', async () => {
    for (const bad of [
      settings({ ageDays: 5 }),
      settings({ graceDays: -1 }),
      settings({ bucket: 'MAL NOMBRE' }),
      settings({ endpoint: 'no-es-url' }),
      settings({ region: '' }),
    ])
      await call(adm, 'put', '/admin/archive/settings', bad).expect(400);
    // habilitar sin clave guardada
    const r = await call(adm, 'put', '/admin/archive/settings', {
      ...settings({ accessKeyId: '' }),
      secret: undefined,
    }).expect(400);
    expect(r.body.code).toBe('NOT_CONFIGURED');
  });

  it('copia lo de más de un año, verifica, libera local y la descarga sigue funcionando desde la nube', async () => {
    const oldKey = await certificate(2023, 400);
    const newKey = await certificate(2025, 30);
    await call(adm, 'put', '/admin/archive/settings', settings()).expect(200);
    const before = await call(adm, 'get', '/admin/archive').expect(200);
    expect(before.body.stats).toMatchObject({ totalObjects: 2, eligible: 1, onlyInCloud: 0 });
    await call(adm, 'post', '/admin/archive/test').expect(200);

    const res = await run().expect(200);
    expect(res.body).toMatchObject({ copied: 1, deletedLocal: 1, failed: 0 });
    expect(hot.objects.has(oldKey)).toBe(false); // liberado de local
    expect(cloud.objects.has(oldKey)).toBe(true);
    expect(hot.objects.has(newKey)).toBe(true); // lo reciente sigue en local
    expect(cloud.objects.has(newKey)).toBe(false);
    // en la nube solo hay bytes cifrados
    expect(cloud.objects.get(oldKey)?.data.subarray(0, 3).toString()).toBe('NF1');
    expect(cloud.objects.get(oldKey)?.data.includes(Buffer.from('historico'))).toBe(false);
    expect(res.body.overview.stats).toMatchObject({ onlyInCloud: 1, eligible: 0 });
    expect(res.body.overview.settings.lastRunStatus).toBe('OK');

    const list = await call(emp, 'get', '/me/tax-certificates').expect(200);
    const byYear = Object.fromEntries(
      (list.body as { year: number; archived: boolean }[]).map((c) => [c.year, c.archived]),
    );
    expect(byYear).toEqual({ 2023: true, 2025: false });

    const pdf = await call(emp, 'get', '/me/tax-certificates/2023/pdf').buffer(true).expect(200);
    expect(Buffer.from(pdf.body as Buffer).equals(PDF)).toBe(true);
    const recent = await call(emp, 'get', '/me/tax-certificates/2025/pdf').buffer(true).expect(200);
    expect(Buffer.from(recent.body as Buffer).equals(PDF)).toBe(true);

    // otra ejecución no repite nada
    expect((await run().expect(200)).body).toMatchObject({ copied: 0, deletedLocal: 0, failed: 0 });
  });

  it('si la nube no responde, lo histórico no está disponible (503) y lo reciente sigue funcionando', async () => {
    await certificate(2023, 400);
    await certificate(2025, 30);
    await call(adm, 'put', '/admin/archive/settings', settings()).expect(200);
    await run().expect(200);
    cloud.down = true;
    await call(emp, 'get', '/me/tax-certificates/2023/pdf').expect(503);
    await call(emp, 'get', '/me/tax-certificates/2025/pdf').expect(200);
  });

  it('una copia corrupta en la nube no se acepta: el original se conserva en local', async () => {
    const key = await certificate(2023, 400);
    await call(adm, 'put', '/admin/archive/settings', settings()).expect(200);
    cloud.corrupt = true;
    const res = await run().expect(200);
    expect(res.body).toMatchObject({ copied: 0, deletedLocal: 0, failed: 1 });
    expect(hot.objects.has(key)).toBe(true);
    expect(await db.select().from(archivedObjects)).toHaveLength(0);
    const [s] = await db.select().from(archiveSettings);
    expect(s?.lastRunStatus).toBe('ERROR');
    const health = await call(adm, 'post', '/admin/health/check').expect(200);
    expect(health.body.checks.find((c: { key: string }) => c.key === 'archive').level).toBe('WARN');
    // la descarga sigue saliendo de local
    await call(emp, 'get', '/me/tax-certificates/2023/pdf').expect(200);
  });

  it('con días de gracia la copia queda en ambos sitios y solo después se libera el local', async () => {
    const key = await certificate(2023, 400);
    await call(adm, 'put', '/admin/archive/settings', settings({ graceDays: 7 })).expect(200);
    expect((await run().expect(200)).body).toMatchObject({ copied: 1, deletedLocal: 0 });
    expect(hot.objects.has(key)).toBe(true);
    let list = await call(emp, 'get', '/me/tax-certificates').expect(200);
    expect(list.body[0].archived).toBe(false); // aún local: sin aviso de demora
    await db.update(archivedObjects).set({ archivedAt: new Date(Date.now() - 8 * DAY) });
    expect((await run().expect(200)).body).toMatchObject({ copied: 0, deletedLocal: 1 });
    expect(hot.objects.has(key)).toBe(false);
    list = await call(emp, 'get', '/me/tax-certificates').expect(200);
    expect(list.body[0].archived).toBe(true);
  });

  it('no archiva si está desactivado ni sin clave; una prueba de conexión fallida se explica', async () => {
    await certificate(2023, 400);
    expect((await run().expect(400)).body.code).toBe('NOT_ENABLED');
    await call(adm, 'post', '/admin/archive/test').expect(400); // sin clave
    await call(adm, 'put', '/admin/archive/settings', settings()).expect(200);
    cloud.down = true;
    const r = await call(adm, 'post', '/admin/archive/test').expect(502);
    expect(r.body.code).toBe('UNAVAILABLE');
    expect(hot.objects.size).toBe(1);
  });

  it('la prueba de conexión explica el motivo: permisos, claves, bucket o red', async () => {
    await call(adm, 'put', '/admin/archive/settings', settings()).expect(200);
    const cases: [{ name: string; status: number | undefined }, number, string][] = [
      [{ name: 'AccessDenied', status: 403 }, 502, 'ACCESS_DENIED'],
      [{ name: 'SignatureDoesNotMatch', status: 403 }, 502, 'INVALID_KEYS'],
      [{ name: 'InvalidAccessKeyId', status: 403 }, 502, 'INVALID_KEYS'],
      [{ name: 'NoSuchBucket', status: 404 }, 502, 'NO_SUCH_BUCKET'],
      [{ name: 'TimeoutError', status: undefined }, 502, 'UNREACHABLE'],
      [{ name: 'InternalError', status: 500 }, 502, 'UNAVAILABLE'],
    ];
    for (const [detail, status, code] of cases) {
      cloud.fail = detail;
      const r = await call(adm, 'post', '/admin/archive/test').expect(status);
      expect(r.body.code, detail.name).toBe(code);
    }
    cloud.fail = null;
    await call(adm, 'post', '/admin/archive/test').expect(200);
    // en el archivado, el fallo por permisos se cuenta y se explica
    await certificate(2023, 400);
    cloud.fail = { name: 'AccessDenied', status: 403 };
    const run1 = await run().expect(200);
    expect(run1.body).toMatchObject({ copied: 0, failed: 1 });
    expect(run1.body.errors[0]).toContain('ACCESS_DENIED');
  });
});
