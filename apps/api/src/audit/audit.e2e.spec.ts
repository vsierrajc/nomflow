import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, auditLogs, employeeSnapshots, roleAssignments } from '../db/schema';
import { RequestAuditService } from './request-audit.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };

describe.skipIf(!url)('auditoría de peticiones y actividades (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let audit: RequestAuditService;
  let hr: Sess = { cookie: '', csrf: '' };
  let hrId = '';

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    audit = app.get(RequestAuditService);
  });
  afterAll(async () => {
    await audit.idle();
    await app.close();
    await ctx.pool.end();
  });

  const srv = () => app.getHttpServer();
  async function login(email: string): Promise<Sess> {
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  const rows = async () => {
    await audit.idle();
    return db.select().from(auditLogs).orderBy(auditLogs.at);
  };
  const http = async () => (await rows()).filter((r) => r.action === 'HTTP_REQUEST');

  beforeEach(async () => {
    await audit.idle();
    await db.execute(
      sql`TRUNCATE audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: 'ADM',
        email: 'hr@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    hrId = a?.id ?? '';
    await db
      .insert(roleAssignments)
      .values({ accountId: hrId, role: 'HR_ADMIN', validFrom: '2020-01-01' });
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1000000001', nCont: '1', email: 'ana@x.co', est: 'V', nombre: 'ANA' });
    await db.insert(accounts).values({
      nIde: '1000000001',
      email: 'ana@x.co',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVA',
      mustChangePassword: false,
    });
    hr = await login('hr@x.co');
    await audit.idle();
    await db.execute(sql`TRUNCATE audit_logs`);
  });

  it('registra cada petición con usuario, método, plantilla de ruta, estado, duración e IP', async () => {
    const ana = await login('ana@x.co');
    await request(srv()).get('/auth/me').set('Cookie', ana.cookie);
    const list = await http();
    const me = list.find((r) => r.resource === '/auth/me');
    expect(me).toMatchObject({ result: '200' });
    expect(me?.actorAccountId).toBeTruthy();
    expect(me?.context).toMatchObject({ method: 'GET' });
    const ctxRow = me?.context as {
      durationMs: number;
      requestId: string;
      ip: string | null;
      userAgent: string | null;
    };
    expect(ctxRow.durationMs).toBeGreaterThanOrEqual(0);
    expect(ctxRow.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctxRow.ip).toBeTruthy();
    const login1 = list.find((r) => r.resource === '/auth/login');
    expect(login1).toMatchObject({ result: '200' });
    expect(login1?.actorAccountId).toBeNull();
  });

  it('registra también los rechazos: sin sesión, sin permiso, clave errónea y rutas inexistentes', async () => {
    const ana = await login('ana@x.co');
    await request(srv()).get('/auth/me');
    await request(srv()).get('/admin/employees').set('Cookie', ana.cookie);
    await request(srv()).post('/auth/login').send({ email: 'ana@x.co', password: 'mala' });
    await request(srv()).get('/ruta/que/no/existe');
    const list = await http();
    const pick = (route: string, status: string) =>
      list.find((r) => r.resource === route && r.result === status);
    expect(pick('/auth/me', '401')?.actorAccountId).toBeNull();
    expect(pick('/admin/employees', '403')?.actorAccountId).toBeTruthy();
    expect(pick('/auth/login', '401')).toBeTruthy();
    expect(pick('(ruta no encontrada)', '404')).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain('/ruta/que/no/existe');
  });

  it('usa la plantilla de la ruta, sin identificaciones, contratos ni identificadores reales', async () => {
    await request(srv())
      .get(
        '/admin/payroll/employees/1000000001/202609/1/CONTRATO-77/pdf?mode=SIN_AJUSTE&reason=motivo%20muy%20secreto%20de%20prueba',
      )
      .set('Cookie', hr.cookie);
    await request(srv())
      .get('/admin/employees/00000000-0000-4000-8000-000000000000')
      .set('Cookie', hr.cookie);
    const list = await http();
    const routes = list.map((r) => r.resource);
    expect(routes).toContain('/admin/payroll/employees/:nIde/:per/:nLiq/:contrato/pdf');
    expect(routes).toContain('/admin/employees/:id');
    const dump = JSON.stringify(list);
    for (const secret of [
      '1000000001',
      'CONTRATO-77',
      '202609',
      '00000000-0000-4000',
      'motivo muy secreto',
    ])
      expect(dump).not.toContain(secret);
    const pdfRow = list.find((r) => r.resource.endsWith('/pdf'));
    expect((pdfRow?.context as { queryKeys: string[] }).queryKeys.sort()).toEqual([
      'mode',
      'reason',
    ]);
  });

  it('nunca guarda cuerpos, claves, códigos, tokens ni cookies', async () => {
    await request(srv())
      .post('/auth/login')
      .send({ email: 'ana@x.co', password: 'ClaveSuperSecreta-99' });
    await request(srv()).post('/auth/activate').send({
      email: 'ana@x.co',
      temporaryPassword: 'TempSecreta1234',
      code: 'ABCD1234',
      newPassword: 'NuevaSecreta-1234567',
    });
    await request(srv()).get('/auth/me').set('Cookie', hr.cookie);
    const dump = JSON.stringify(await rows());
    for (const secret of [
      'ClaveSuperSecreta',
      'TempSecreta',
      'ABCD1234',
      'NuevaSecreta',
      hr.cookie.split('=')[1] ?? 'x',
      hr.csrf,
      'ana@x.co',
    ]) {
      expect(dump, secret).not.toContain(secret);
    }
  });

  it('no registra el sondeo de salud y cada respuesta lleva un identificador de petición', async () => {
    const res = await request(srv()).get('/health');
    expect(res.headers['x-request-id']).toBeUndefined();
    const res2 = await request(srv()).get('/auth/me');
    expect(res2.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await http()).map((r) => r.resource)).toEqual(['/auth/me']);
  });

  it('un fallo al escribir la auditoría no rompe la petición', async () => {
    await audit.idle();
    await db.execute(sql`ALTER TABLE audit_logs RENAME TO audit_logs_x`);
    try {
      const res = await request(srv()).get('/auth/me').set('Cookie', hr.cookie);
      expect(res.status).toBe(200);
      await audit.idle();
    } finally {
      await db.execute(sql`ALTER TABLE audit_logs_x RENAME TO audit_logs`);
    }
  });

  describe('consulta del administrador', () => {
    const get = (path: string, s: Sess = hr) => request(srv()).get(path).set('Cookie', s.cookie);

    it('ve peticiones y actividades de todos los usuarios con filtros y paginación', async () => {
      const ana = await login('ana@x.co');
      await get('/auth/me', ana);
      await get('/admin/employees', ana);
      await request(srv()).get('/auth/me');
      await audit.idle();

      const all = await get('/admin/audit?pageSize=200');
      expect(all.status).toBe(200);
      const actors = new Set(all.body.items.map((i: { actor: string | null }) => i.actor));
      expect(actors).toContain('ana@x.co');
      expect(actors).toContain(null);
      expect(all.headers['cache-control']).toContain('no-store');

      const events = await get('/admin/audit?kind=EVENT&pageSize=200');
      expect(events.body.items.every((i: { action: string }) => i.action !== 'HTTP_REQUEST')).toBe(
        true,
      );
      expect(events.body.items.map((i: { action: string }) => i.action)).toContain('LOGIN');

      const forbidden = await get('/admin/audit?kind=HTTP&status=403&pageSize=200');
      expect(forbidden.body.total).toBe(1);
      expect(forbidden.body.items[0]).toMatchObject({
        actor: 'ana@x.co',
        resource: '/admin/employees',
        result: '403',
      });
      expect(forbidden.body.items[0].context).toMatchObject({ method: 'GET' });

      expect(
        (await get('/admin/audit?kind=HTTP&actor=ana&pageSize=200')).body.items.every(
          (i: { actor: string }) => i.actor === 'ana@x.co',
        ),
      ).toBe(true);
      expect(
        (await get('/admin/audit?kind=HTTP&method=POST&pageSize=200')).body.items.every(
          (i: { context: { method: string } }) => i.context.method === 'POST',
        ),
      ).toBe(true);
      expect(
        (await get('/admin/audit?route=/auth/me&pageSize=200')).body.total,
      ).toBeGreaterThanOrEqual(2);

      const p1 = await get('/admin/audit?pageSize=3&page=1');
      const p2 = await get('/admin/audit?pageSize=3&page=2');
      expect(p1.body.items).toHaveLength(3);
      expect(p1.body.items[0].id).not.toBe(p2.body.items[0].id);
      expect(p1.body.total).toBeGreaterThan(3);
    });

    it('filtra por fechas y valida los parámetros', async () => {
      await get('/auth/me');
      await audit.idle();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
        new Date(),
      );
      expect((await get(`/admin/audit?from=${today}&to=${today}`)).body.total).toBeGreaterThan(0);
      expect((await get('/admin/audit?from=2000-01-01&to=2000-01-02')).body.total).toBe(0);
      expect((await get('/admin/audit?from=ayer')).status).toBe(400);
      expect((await get('/admin/audit?method=TRACE')).status).toBe(400);
      expect((await get('/admin/audit?status=abc')).status).toBe(400);
      expect((await get('/admin/audit?pageSize=999')).status).toBe(400);
    });

    it('la propia consulta del registro queda registrada', async () => {
      await get('/admin/audit');
      await audit.idle();
      const again = await get('/admin/audit?route=/admin/audit&kind=HTTP');
      expect(
        again.body.items.some(
          (i: { resource: string; actor: string }) =>
            i.resource === '/admin/audit' && i.actor === 'hr@x.co',
        ),
      ).toBe(true);
    });

    it('solo el personal administrador puede consultarlo', async () => {
      const ana = await login('ana@x.co');
      expect((await get('/admin/audit', ana)).status).toBe(403);
      expect((await request(srv()).get('/admin/audit')).status).toBe(401);
    });
  });
});
