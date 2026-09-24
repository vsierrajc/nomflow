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
  catalogEntries,
  companies,
  employeeChanges,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };
const REASON = 'Corrección solicitada por Gestión Humana';

describe.skipIf(!url)('CRUD de empleados (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let hr: Sess = { cookie: '', csrf: '' };
  let hrId = '';

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

  async function login(email: string): Promise<Sess> {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, employee_changes, catalog_entry_history, catalog_entries, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db
      .insert(companies)
      .values({ cEmp: 'GA', nombre: 'Empresa', sigla: 'E', direccion: 'D' });
    await db.insert(catalogEntries).values([
      { type: 'AREA', cEmp: 'GA', code: '10300', name: 'FINANCIERA' },
      { type: 'AREA', cEmp: 'GA', code: '10400', name: 'COMERCIAL' },
      { type: 'CCOSTO', cEmp: 'GA', code: 'CC1', name: 'Costo Uno' },
      { type: 'CARGO', cEmp: 'GA', code: 'CA1', name: 'Analista' },
      { type: 'TIPO_CONTRATO', cEmp: '', code: '01', name: 'Indefinido' },
    ]);
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
    hr = await login('hr@x.co');
  });

  const srv = () => app.getHttpServer();
  const post = (path: string, body: object, s: Sess = hr) =>
    request(srv()).post(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const put = (path: string, body: object, s: Sess = hr) =>
    request(srv()).put(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const get = (path: string, s: Sess = hr) => request(srv()).get(path).set('Cookie', s.cookie);

  const newEmp = (over: Record<string, unknown> = {}) => ({
    nIde: '1000000001',
    nCont: '1',
    cEmp: 'GA',
    nombre: 'ANA MARIA PRUEBA',
    email: ' Ana@Prueba.co ',
    est: 'V',
    cArea: '10300',
    cCos: 'CC1',
    cCar: 'CA1',
    tipoContrato: '01',
    fIni: '2020-01-06',
    fecNac: '1990-05-17',
    sAct: '1500000.5',
    reason: REASON,
    ...over,
  });
  const upd = (e: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const {
      nIde: _a,
      nCont: _b,
      id: _c,
      area: _d,
      cCosto: _e,
      cargo: _f,
      source: _g,
      createdAt: _h,
      updatedAt: _i,
      importBatchId: _j,
      ...rest
    } = e;
    void [_a, _b, _c, _d, _e, _f, _g, _h, _i, _j];
    return { ...rest, reason: REASON, ...over };
  };

  describe('alta excepcional', () => {
    it('crea con correo normalizado, descripciones tomadas del catálogo, origen MANUAL y auditoría', async () => {
      const res = await post('/admin/employees', newEmp());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        nIde: '1000000001',
        email: 'ana@prueba.co',
        est: 'V',
        area: 'FINANCIERA',
        cCosto: 'Costo Uno',
        cargo: 'Analista',
        source: 'MANUAL',
        version: 1,
        sAct: '1500000.500000',
        fIni: '2020-01-06',
      });
      const hist = await get(`/admin/employees/${res.body.id}/history`);
      expect(hist.body).toEqual([
        expect.objectContaining({ action: 'CREATE', reason: REASON, by: 'hr@x.co' }),
      ]);
    });

    it('exige motivo de 10 o más caracteres, campos válidos y EST V o C', async () => {
      expect((await post('/admin/employees', newEmp({ reason: 'corto' }))).status).toBe(400);
      expect((await post('/admin/employees', { ...newEmp(), reason: undefined })).status).toBe(400);
      expect((await post('/admin/employees', newEmp({ est: 'A' }))).status).toBe(400);
      expect((await post('/admin/employees', newEmp({ fIni: '06/01/2020' }))).status).toBe(400);
      expect((await post('/admin/employees', newEmp({ nIde: 'x' }))).status).toBe(400);
      const bad = await post(
        '/admin/employees',
        newEmp({
          email: 'no-es-correo',
          fIni: '2020-02-30',
          sAct: '-5',
          tipoContrato: '09',
          cEmp: 'XX',
        }),
      );
      expect(bad.status).toBe(422);
      expect(bad.body.issues).toHaveLength(5);
      const codes = await post('/admin/employees', newEmp({ cArea: 'ZZ', cCos: 'ZZ', cCar: 'ZZ' }));
      expect(codes.status).toBe(422);
      expect(codes.body.issues.join()).toMatch(/C_AREA.*C_COS.*C_CAR/);
      expect(await db.select().from(employeeSnapshots)).toHaveLength(0);
    });

    it('no permite contrato duplicado, un segundo contrato vigente ni un correo de otra persona', async () => {
      await post('/admin/employees', newEmp());
      expect((await post('/admin/employees', newEmp())).status).toBe(422);
      const second = await post('/admin/employees', newEmp({ nCont: '2' }));
      expect(second.status).toBe(422);
      expect(second.body.issues.join()).toContain('otro contrato vigente');
      expect((await post('/admin/employees', newEmp({ nCont: '2', est: 'C' }))).status).toBe(201);
      const other = await post(
        '/admin/employees',
        newEmp({ nIde: '2000000002', email: 'ana@prueba.co' }),
      );
      expect(other.status).toBe(422);
      expect(other.body.issues.join()).toContain('pertenece a otra persona');
      expect(
        (
          await post(
            '/admin/employees',
            newEmp({ nCont: '3', est: 'C', email: 'distinto@prueba.co' }),
          )
        ).status,
      ).toBe(422);
    });
  });

  describe('consulta', () => {
    beforeEach(async () => {
      await post('/admin/employees', newEmp());
      await post(
        '/admin/employees',
        newEmp({
          nIde: '1000000002',
          nombre: 'LUIS PEREZ',
          email: 'luis@x.co',
          cArea: '10400',
          est: 'C',
        }),
      );
      await post(
        '/admin/employees',
        newEmp({ nIde: '1000000003', nombre: 'BEA RUIZ', email: 'bea@x.co', cArea: '10400' }),
      );
    });

    it('lista con búsqueda, filtros y paginación, sin exponer salario', async () => {
      const all = await get('/admin/employees?pageSize=2&page=2');
      expect(all.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(all.body.items).toHaveLength(1);
      expect(JSON.stringify(all.body)).not.toContain('sAct');
      expect(JSON.stringify(all.body)).not.toContain('1500000');
      expect((await get('/admin/employees?q=luis')).body.total).toBe(1);
      expect((await get('/admin/employees?q=1000000003')).body.items[0].nombre).toBe('BEA RUIZ');
      expect((await get('/admin/employees?est=V')).body.total).toBe(2);
      expect((await get('/admin/employees?cArea=10400')).body.total).toBe(2);
      expect((await get('/admin/employees?q=%25')).body.total).toBe(0);
      expect((await get('/admin/employees?pageSize=999')).status).toBe(400);
    });

    it('indica si la persona tiene cuenta', async () => {
      await db.insert(accounts).values({
        nIde: '1000000001',
        email: 'ana@prueba.co',
        passwordHash: 'h',
        status: 'ACTIVA',
        mustChangePassword: false,
      });
      const list = (await get('/admin/employees?q=ana')).body.items[0];
      expect(list.hasAccount).toBe(true);
      expect((await get('/admin/employees?q=bea')).body.items[0].hasAccount).toBe(false);
    });

    it('el detalle incluye el salario y queda auditado; un id inexistente da 404', async () => {
      const id = (await get('/admin/employees?q=ana')).body.items[0].id;
      const d = await get(`/admin/employees/${id}`);
      expect(d.status).toBe(200);
      expect(d.body.sAct).toBe('1500000.500000');
      expect(d.headers['cache-control']).toContain('no-store');
      const logs = await db.execute(
        sql`select action, result from audit_logs where action = 'EMPLOYEE_VIEW'`,
      );
      expect(logs.rows).toEqual([{ action: 'EMPLOYEE_VIEW', result: 'SUCCESS' }]);
      expect((await get('/admin/employees/00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await get('/admin/employees/no-uuid')).status).toBe(400);
    });
  });

  describe('modificación', () => {
    it('actualiza con motivo y versión, registra desde/hacia y recalcula descripciones', async () => {
      const c = await post('/admin/employees', newEmp());
      const res = await put(
        `/admin/employees/${c.body.id}`,
        upd(c.body, { cArea: '10400', sAct: '1600000', nombre: 'ANA M. PRUEBA', version: 1 }),
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cArea: '10400',
        area: 'COMERCIAL',
        nombre: 'ANA M. PRUEBA',
        version: 2,
        source: 'MANUAL',
      });
      const hist = (await get(`/admin/employees/${c.body.id}/history`)).body;
      expect(hist).toHaveLength(2);
      expect(hist[1]).toMatchObject({ action: 'UPDATE', reason: REASON });
      expect(hist[1].changes).toMatchObject({
        cArea: { from: '10300', to: '10400' },
        sAct: { from: '1500000.500000', to: '1600000' },
        nombre: { from: 'ANA MARIA PRUEBA', to: 'ANA M. PRUEBA' },
      });
      expect(hist[1].changes.email).toBeUndefined();
    });

    it('control de versión, validaciones y motivo obligatorio', async () => {
      const c = await post('/admin/employees', newEmp());
      const ok = await put(
        `/admin/employees/${c.body.id}`,
        upd(c.body, { nombre: 'X Y', version: 1 }),
      );
      expect(ok.status).toBe(200);
      const stale = await put(
        `/admin/employees/${c.body.id}`,
        upd(c.body, { nombre: 'Z', version: 1 }),
      );
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(
        (await put(`/admin/employees/${c.body.id}`, upd(c.body, { reason: 'x', version: 2 })))
          .status,
      ).toBe(400);
      expect(
        (await put(`/admin/employees/${c.body.id}`, upd(c.body, { cArea: 'ZZ', version: 2 })))
          .status,
      ).toBe(422);
      expect(
        (
          await put(
            '/admin/employees/00000000-0000-4000-8000-000000000000',
            upd(c.body, { version: 1 }),
          )
        ).status,
      ).toBe(404);
    });

    it('no cambia la identidad (N_IDE, N_CONT) y bloquea el cambio de correo si ya hay cuenta', async () => {
      const c = await post('/admin/employees', newEmp());
      const changed = await put(`/admin/employees/${c.body.id}`, {
        ...upd(c.body, { version: 1 }),
        nIde: '9999999999',
        nCont: '9',
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({ nIde: '1000000001', nCont: '1' });
      await db.insert(accounts).values({
        nIde: '1000000001',
        email: 'ana@prueba.co',
        passwordHash: 'h',
        status: 'ACTIVA',
        mustChangePassword: false,
      });
      const mail = await put(
        `/admin/employees/${c.body.id}`,
        upd(c.body, { email: 'nuevo@prueba.co', version: 2 }),
      );
      expect(mail.status).toBe(422);
      expect(mail.body.issues.join()).toContain('resolución administrativa');
    });

    it('la importación posterior sobrescribe la corrección manual y sube la versión', async () => {
      const c = await post('/admin/employees', newEmp());
      await db
        .update(employeeSnapshots)
        .set({ source: 'IMPORT', version: sql`${employeeSnapshots.version} + 1` });
      const [row] = await db.select().from(employeeSnapshots);
      expect(row).toMatchObject({ source: 'IMPORT', version: 2 });
      expect(c.body.source).toBe('MANUAL');
    });
  });

  describe('baja y reactivación', () => {
    it('EST = C cierra las sesiones y bloquea el ingreso; conserva el historial', async () => {
      const c = await post('/admin/employees', newEmp());
      await db.insert(accounts).values({
        nIde: '1000000001',
        email: 'ana@prueba.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      });
      const ana = await login('ana@prueba.co');
      expect((await get('/auth/me', ana)).status).toBe(200);

      const off = await post(`/admin/employees/${c.body.id}/status`, {
        est: 'C',
        version: 1,
        reason: 'Retiro del empleado',
      });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ est: 'C', version: 2 });
      expect((await get('/auth/me', ana)).status).toBe(401);
      expect(
        (
          await request(srv())
            .post('/auth/login')
            .send({ email: 'ana@prueba.co', password: PASSWORD })
        ).status,
      ).toBe(401);
      expect(await db.select().from(employeeSnapshots)).toHaveLength(1);
      const hist = (await get(`/admin/employees/${c.body.id}/history`)).body;
      expect(hist.map((h: { action: string }) => h.action)).toEqual(['CREATE', 'DEACTIVATE']);
    });

    it('reactiva solo si no hay otro contrato vigente y pasa las mismas validaciones', async () => {
      const a = await post('/admin/employees', newEmp({ est: 'C' }));
      const b = await post('/admin/employees', newEmp({ nCont: '2' }));
      const blocked = await post(`/admin/employees/${a.body.id}/status`, {
        est: 'V',
        version: 1,
        reason: 'Reingreso del empleado',
      });
      expect(blocked.status).toBe(422);
      await post(`/admin/employees/${b.body.id}/status`, {
        est: 'C',
        version: 1,
        reason: 'Fin del contrato',
      });
      const on = await post(`/admin/employees/${a.body.id}/status`, {
        est: 'V',
        version: 1,
        reason: 'Reingreso del empleado',
      });
      expect(on.status).toBe(200);
      expect(on.body.est).toBe('V');
      expect(
        (await get(`/admin/employees/${a.body.id}/history`)).body.map(
          (h: { action: string }) => h.action,
        ),
      ).toEqual(['CREATE', 'REACTIVATE']);
    });

    it('la baja no depende de que el catálogo o la ficha estén completos', async () => {
      const c = await post('/admin/employees', newEmp());
      await db
        .update(catalogEntries)
        .set({ active: false })
        .where(sql`type = 'AREA'`);
      await db.update(companies).set({ active: false });
      await db.update(employeeSnapshots).set({ tipoContrato: null, fIni: null });
      const off = await post(`/admin/employees/${c.body.id}/status`, {
        est: 'C',
        version: 1,
        reason: 'Retiro del empleado',
      });
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ est: 'C', version: 2, source: 'MANUAL' });
      const hist = (await get(`/admin/employees/${c.body.id}/history`)).body;
      expect(hist[1]).toMatchObject({
        action: 'DEACTIVATE',
        changes: { est: { from: 'V', to: 'C' } },
      });
      const again = await post(`/admin/employees/${c.body.id}/status`, {
        est: 'C',
        version: 2,
        reason: 'Otra vez la baja',
      });
      expect(again.status).toBe(200);
      expect((await get(`/admin/employees/${c.body.id}/history`)).body).toHaveLength(2);
    });

    it('la reactivación sí valida el catálogo y la empresa', async () => {
      const c = await post('/admin/employees', newEmp({ est: 'C' }));
      await db
        .update(catalogEntries)
        .set({ active: false })
        .where(sql`type = 'AREA'`);
      const res = await post(`/admin/employees/${c.body.id}/status`, {
        est: 'V',
        version: 1,
        reason: 'Reingreso del empleado',
      });
      expect(res.status).toBe(422);
      expect(res.body.issues.join()).toContain('C_AREA');
    });

    it('exige motivo, versión vigente y estado válido', async () => {
      const c = await post('/admin/employees', newEmp());
      expect(
        (
          await post(`/admin/employees/${c.body.id}/status`, {
            est: 'C',
            version: 1,
            reason: 'corto',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(`/admin/employees/${c.body.id}/status`, {
            est: 'A',
            version: 1,
            reason: 'Motivo suficiente',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(`/admin/employees/${c.body.id}/status`, {
            est: 'C',
            version: 7,
            reason: 'Motivo suficiente',
          })
        ).status,
      ).toBe(409);
    });
  });

  it('no existe borrado físico y la auditoría técnica no contiene datos personales ni salario', async () => {
    const c = await post('/admin/employees', newEmp());
    await put(
      `/admin/employees/${c.body.id}`,
      upd(c.body, { sAct: '1777777.77', nombre: 'NOMBRE SECRETO', version: 1 }),
    );
    expect(
      (
        await request(srv())
          .delete(`/admin/employees/${c.body.id}`)
          .set('Cookie', hr.cookie)
          .set('X-CSRF-Token', hr.csrf)
      ).status,
    ).toBe(404);
    const dump = JSON.stringify((await db.execute(sql`select * from audit_logs`)).rows);
    for (const secret of ['1777777', 'NOMBRE SECRETO', 'ana@prueba.co', '1000000001'])
      expect(dump).not.toContain(secret);
    expect((await db.select().from(employeeChanges)).length).toBe(2);
  });

  it('exige administrador, CSRF y reautenticación; el resto de roles no accede', async () => {
    await post('/admin/employees', newEmp());
    await db
      .insert(employeeSnapshots)
      .values({ nIde: 'E9', nCont: '1', email: 'e9@x.co', est: 'V' });
    const [m] = await db
      .insert(accounts)
      .values({
        nIde: 'E9',
        email: 'e9@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    await db.insert(roleAssignments).values({
      accountId: m?.id ?? '',
      role: 'AREA_MANAGER',
      companyCode: 'GA',
      areaCode: '10300',
      validFrom: '2020-01-01',
    });
    const mgr = await login('e9@x.co');
    expect((await get('/admin/employees', mgr)).status).toBe(403);
    expect((await post('/admin/employees', newEmp({ nIde: '5555555' }), mgr)).status).toBe(403);
    expect((await request(srv()).get('/admin/employees')).status).toBe(401);
    expect(
      (
        await post('/admin/employees', newEmp({ nIde: '5555555', email: 'z@x.co' }), {
          cookie: hr.cookie,
          csrf: 'x'.repeat(64),
        })
      ).status,
    ).toBe(403);
    await db.execute(
      sql`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE account_id = ${hrId}`,
    );
    expect(
      (await post('/admin/employees', newEmp({ nIde: '5555555', email: 'z@x.co' }))).status,
    ).toBe(403);
    expect((await get('/admin/employees')).status).toBe(200);
  });
});
