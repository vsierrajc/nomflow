import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  areaManagerAssignments,
  catalogEntries,
  companies,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { EMPLOYEE_COLUMNS } from './employees.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };

describe.skipIf(!url)(
  'CRUD de áreas, centros de costo, cargos y tipos de contrato (HTTP + PostgreSQL)',
  () => {
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
        sql`TRUNCATE audit_logs, area_manager_assignments, catalog_entry_history, catalog_entries, import_batch_rows, import_batches, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
      );
      await db
        .insert(companies)
        .values({ cEmp: 'GA', nombre: 'Empresa', sigla: 'E', direccion: 'D' });
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

    describe.each([
      ['AREA', '10300', 'FINANCIERA', 'FINANCIERA Y CONTABLE'],
      ['CCOSTO', 'FA1403', 'PRODUCCION', 'PRODUCCION PLANTA 1'],
      ['CARGO', 'C001', 'ANALISTA', 'ANALISTA SENIOR'],
    ])('%s', (kind, code, name, renamed) => {
      it('crea, consulta con búsqueda y paginación, evita duplicados y valida', async () => {
        const c = await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code, name: `  ${name}  ` });
        expect(c.status).toBe(201);
        expect(c.body).toMatchObject({ code, name, active: true, version: 1, cEmp: 'GA' });
        expect(
          (await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code, name: 'otro' })).status,
        ).toBe(409);
        expect((await post(`/admin/catalogs/${kind}`, { code, name })).status).toBe(422);
        expect(
          (await post(`/admin/catalogs/${kind}`, { cEmp: 'XX', code: 'Z', name })).status,
        ).toBe(422);
        expect((await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code: '', name })).status).toBe(
          400,
        );
        for (let i = 0; i < 4; i++)
          await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code: `X${i}`, name: `Extra ${i}` });

        const all = await get(`/admin/catalogs/${kind}?cEmp=GA&pageSize=2&page=2`);
        expect(all.body).toMatchObject({ total: 5, page: 2, pageSize: 2 });
        expect(
          (await get(`/admin/catalogs/${kind}?cEmp=GA&q=${name.slice(0, 4)}`)).body.total,
        ).toBe(1);
        expect((await get(`/admin/catalogs/${kind}?cEmp=GA&q=%25`)).body.total).toBe(0);
        expect((await get(`/admin/catalogs/${kind}`)).status).toBe(400);
        expect((await get(`/admin/catalogs/${kind}?cEmp=OTRA`)).body.total).toBe(0);
      });

      it('modifica con control de versión y conserva el historial de nombres', async () => {
        const c = await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code, name });
        const ok = await put(`/admin/catalogs/${kind}/${c.body.id}`, {
          name: renamed,
          active: true,
          version: 1,
        });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ name: renamed, version: 2 });
        const stale = await put(`/admin/catalogs/${kind}/${c.body.id}`, {
          name: 'x',
          active: true,
          version: 1,
        });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('VERSION_CONFLICT');
        const hist = await get(`/admin/catalogs/${kind}/${c.body.id}/history`);
        expect(hist.body).toEqual([expect.objectContaining({ oldName: name, newName: renamed })]);
        await put(`/admin/catalogs/${kind}/${c.body.id}`, {
          name: renamed,
          active: true,
          version: 2,
        });
        expect((await get(`/admin/catalogs/${kind}/${c.body.id}/history`)).body).toHaveLength(1);
      });

      it('desactiva sin borrar, reactiva y no permite cambiar entradas de otro catálogo', async () => {
        const c = await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code, name });
        const off = await put(`/admin/catalogs/${kind}/${c.body.id}`, {
          name,
          active: false,
          version: 1,
        });
        expect(off.body.active).toBe(false);
        expect(await db.select().from(catalogEntries)).toHaveLength(1);
        expect((await get(`/admin/catalogs/${kind}?cEmp=GA&active=false`)).body.total).toBe(1);
        expect((await get(`/admin/catalogs/${kind}?cEmp=GA&active=true`)).body.total).toBe(0);
        const on = await put(`/admin/catalogs/${kind}/${c.body.id}`, {
          name,
          active: true,
          version: 2,
        });
        expect(on.body.active).toBe(true);
        const other = kind === 'AREA' ? 'CARGO' : 'AREA';
        expect(
          (await put(`/admin/catalogs/${other}/${c.body.id}`, { name, active: true, version: 3 }))
            .status,
        ).toBe(404);
      });
    });

    it('TIPO_CONTRATO es global: ignora la empresa y conserva el cero inicial', async () => {
      const c = await post('/admin/catalogs/TIPO_CONTRATO', { code: '01', name: 'INDEFINIDO' });
      expect(c.status).toBe(201);
      expect(c.body.cEmp).toBe('');
      expect(
        (await post('/admin/catalogs/TIPO_CONTRATO', { cEmp: 'GA', code: '01', name: 'otro' }))
          .status,
      ).toBe(409);
      expect((await get('/admin/catalogs/TIPO_CONTRATO')).body.items[0]).toMatchObject({
        code: '01',
        name: 'INDEFINIDO',
      });
    });

    describe('baja lógica con dependencias', () => {
      const employee = (over: Partial<typeof employeeSnapshots.$inferInsert>) =>
        db
          .insert(employeeSnapshots)
          .values({ nIde: '1', nCont: '1', email: 'a@x.co', est: 'V', cEmp: 'GA', ...over });

      it.each([
        ['AREA', { cArea: '10300' }, '10300'],
        ['CCOSTO', { cCos: 'FA1403' }, 'FA1403'],
        ['CARGO', { cCar: 'C001' }, 'C001'],
        ['TIPO_CONTRATO', { tipoContrato: '01' }, '01'],
      ] as const)(
        '%s en uso por empleados vigentes no se puede desactivar',
        async (kind, fields, code) => {
          const c = await post(`/admin/catalogs/${kind}`, { cEmp: 'GA', code, name: 'X' });
          await employee(fields);
          const res = await put(`/admin/catalogs/${kind}/${c.body.id}`, {
            name: 'X',
            active: false,
            version: 1,
          });
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ code: 'IN_USE', usage: { employees: 1 } });
          expect(
            (
              await db
                .select()
                .from(catalogEntries)
                .where(sql`id = ${c.body.id}`)
            )[0]?.active,
          ).toBe(true);
          await db.update(employeeSnapshots).set({ est: 'C' });
          expect(
            (
              await put(`/admin/catalogs/${kind}/${c.body.id}`, {
                name: 'X',
                active: false,
                version: 1,
              })
            ).status,
          ).toBe(200);
        },
      );

      it('un área con jefe vigente asignado no se puede desactivar', async () => {
        const c = await post('/admin/catalogs/AREA', { cEmp: 'GA', code: '10300', name: 'F' });
        await db.insert(areaManagerAssignments).values({
          cEmp: 'GA',
          cArea: '10300',
          managerAccountId: hrId,
          validFrom: '2020-01-01',
          createdBy: hrId,
        });
        const res = await put(`/admin/catalogs/AREA/${c.body.id}`, {
          name: 'F',
          active: false,
          version: 1,
        });
        expect(res.status).toBe(409);
        expect(res.body.usage).toMatchObject({ managers: 1 });
        await db.update(areaManagerAssignments).set({ validTo: '2021-01-01' });
        expect(
          (await put(`/admin/catalogs/AREA/${c.body.id}`, { name: 'F', active: false, version: 1 }))
            .status,
        ).toBe(200);
      });
    });

    it('un área desactivada deja de aceptarse en la importación de EMPLEADOS', async () => {
      const area = await post('/admin/catalogs/AREA', { cEmp: 'GA', code: 'A1', name: 'Area Uno' });
      await post('/admin/catalogs/TIPO_CONTRATO', { code: '01', name: 'Indefinido' });
      await put(`/admin/catalogs/AREA/${area.body.id}`, {
        name: 'Area Uno',
        active: false,
        version: 1,
      });
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow([...EMPLOYEE_COLUMNS]);
      const row: Record<string, string | number | Date> = {
        C_EMP: 'GA',
        N_IDE: '1000',
        NOMBRE: 'ANA',
        N_CONT: '1',
        C_AREA: 'A1',
        F_INI: new Date(Date.UTC(2020, 0, 1)),
        EST: 'V',
        EMAIL: 'ana@x.co',
        TIPO_CONTRATO: '01',
      };
      ws.addRow(EMPLOYEE_COLUMNS.map((c) => row[c] ?? null));
      const up = await request(srv())
        .post('/admin/imports/employees')
        .set('Cookie', hr.cookie)
        .set('X-CSRF-Token', hr.csrf)
        .field('sourceSystem', 'ERP')
        .field('responsible', 'GH')
        .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'e.xlsx' });
      expect(up.body.status).toBe('OBSERVADO');
      await put(`/admin/catalogs/AREA/${area.body.id}`, {
        name: 'Area Uno',
        active: true,
        version: 2,
      });
      const wb2 = Buffer.from(await wb.xlsx.writeBuffer());
      const again = await request(srv())
        .post('/admin/imports/employees')
        .set('Cookie', hr.cookie)
        .set('X-CSRF-Token', hr.csrf)
        .field('sourceSystem', 'ERP')
        .field('responsible', 'GH')
        .attach('file', wb2, { filename: 'e2.xlsx' });
      expect(again.body.status).toBe('LISTO');
    });

    it('la importación de catálogos y el CRUD comparten versión', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['C_ARE', 'NOMAREA']);
      ws.addRow(['A1', 'NOMBRE IMPORTADO']);
      const up = await request(srv())
        .post('/admin/imports/catalogs/AREA')
        .set('Cookie', hr.cookie)
        .set('X-CSRF-Token', hr.csrf)
        .field('sourceSystem', 'ERP')
        .field('responsible', 'GH')
        .field('cEmp', 'GA')
        .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'a.xlsx' });
      await post(`/admin/imports/${up.body.id}/apply`, {});
      const list = await get('/admin/catalogs/AREA?cEmp=GA');
      expect(list.body.items[0]).toMatchObject({ code: 'A1', version: 1 });
      const upd = await put(`/admin/catalogs/AREA/${list.body.items[0].id}`, {
        name: 'NOMBRE MANUAL',
        active: true,
        version: 1,
      });
      expect(upd.body.version).toBe(2);
    });

    it('exige administrador, CSRF y reautenticación reciente', async () => {
      await db
        .insert(employeeSnapshots)
        .values({ nIde: 'E1', nCont: '1', email: 'e1@x.co', est: 'V' });
      await db.insert(accounts).values({
        nIde: 'E1',
        email: 'e1@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      });
      const emp = await login('e1@x.co');
      expect((await get('/admin/catalogs/AREA?cEmp=GA', emp)).status).toBe(403);
      expect(
        (await post('/admin/catalogs/AREA', { cEmp: 'GA', code: 'A', name: 'B' }, emp)).status,
      ).toBe(403);
      expect(
        (
          await post(
            '/admin/catalogs/AREA',
            { cEmp: 'GA', code: 'A', name: 'B' },
            { cookie: hr.cookie, csrf: 'x'.repeat(64) },
          )
        ).status,
      ).toBe(403);
      expect((await request(srv()).get('/admin/catalogs/AREA?cEmp=GA')).status).toBe(401);
      expect((await get('/admin/catalogs/INVENTADO?cEmp=GA')).status).toBe(404);
      await db.execute(
        sql`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE account_id = ${hrId}`,
      );
      expect(
        (await post('/admin/catalogs/AREA', { cEmp: 'GA', code: 'A', name: 'B' })).status,
      ).toBe(403);
      expect((await get('/admin/catalogs/AREA?cEmp=GA')).status).toBe(200);
    });
  },
);
