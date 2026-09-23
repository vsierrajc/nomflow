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
  catalogEntries,
  catalogEntryHistory,
  companies,
  employeeSnapshots,
  importBatches,
  roleAssignments,
} from '../db/schema';
import { EMPLOYEE_COLUMNS } from './employees.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';

type Cell = string | number | Date | null;

async function sheet(columns: string[], rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja 1');
  ws.addRow(columns);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!url)('empresas y catálogos organizacionales (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let cookie = '';
  let csrf = '';

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

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, catalog_entry_history, catalog_entries, companies, import_batch_rows, import_batches, verification_codes, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: 'ADM1',
        email: 'hr@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    await db
      .insert(roleAssignments)
      .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'hr@x.co', password: PASSWORD });
    cookie = String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '';
    csrf = res.body.csrfToken as string;
  });

  const authed = (r: request.Test) => r.set('Cookie', cookie).set('X-CSRF-Token', csrf);
  const srv = () => app.getHttpServer();
  const company = (over: object = {}) =>
    authed(request(srv()).post('/admin/companies')).send({
      cEmp: '01',
      nombre: 'Empresa Uno',
      sigla: 'EU',
      direccion: 'Calle 1',
      ...over,
    });
  const uploadCatalog = (
    kind: string,
    buf: Buffer,
    fields: Record<string, string> = { cEmp: '01' },
  ) => {
    const r = authed(request(srv()).post(`/admin/imports/catalogs/${kind}`))
      .field('sourceSystem', 'ERP')
      .field('responsible', 'Gestión Humana');
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('file', buf, { filename: 'cat.xlsx' });
  };
  const apply = (id: string) => authed(request(srv()).post(`/admin/imports/${id}/apply`));
  const errorsOf = async (id: string) =>
    (await request(srv()).get(`/admin/imports/${id}/errors`).set('Cookie', cookie)).body.errors as {
      rule: string;
      column: string;
    }[];

  describe('empresas', () => {
    it('crea, lista, actualiza con control de versión y audita', async () => {
      const created = await company();
      expect(created.status).toBe(201);
      expect(created.body.version).toBe(1);
      expect((await company()).status).toBe(409);
      const list = await request(srv()).get('/admin/companies').set('Cookie', cookie);
      expect(list.body).toHaveLength(1);
      const upd = await authed(request(srv()).put(`/admin/companies/${created.body.id}`)).send({
        nombre: 'Nueva',
        sigla: 'N',
        direccion: 'Calle 2',
        active: true,
        version: 1,
      });
      expect(upd.status).toBe(200);
      expect(upd.body.version).toBe(2);
      const stale = await authed(request(srv()).put(`/admin/companies/${created.body.id}`)).send({
        nombre: 'X',
        sigla: 'X',
        direccion: 'X',
        active: true,
        version: 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
    });

    it('valida el cuerpo y exige rol', async () => {
      expect((await company({ sigla: '' })).status).toBe(400);
      await db
        .insert(employeeSnapshots)
        .values({ nIde: 'E1', nCont: '1', email: 'e1@x.co', est: 'V' });
      await db
        .insert(accounts)
        .values({
          nIde: 'E1',
          email: 'e1@x.co',
          passwordHash: await hashPassword(PASSWORD),
          status: 'ACTIVA',
          mustChangePassword: false,
        });
      const l = await request(srv())
        .post('/auth/login')
        .send({ email: 'e1@x.co', password: PASSWORD });
      const c = String(l.headers['set-cookie']?.[0]).split(';')[0] ?? '';
      expect((await request(srv()).get('/admin/companies').set('Cookie', c)).status).toBe(403);
    });
  });

  describe('importación de catálogos', () => {
    it('AREA: acepta JEFE_AREA vacío sin usarlo, aplica y lista', async () => {
      await company();
      const up = await uploadCatalog(
        'AREA',
        await sheet(
          ['C_ARE', 'NOMAREA', 'JEFE_AREA'],
          [
            ['A1', 'Area  Uno', null],
            ['A2', 'Area Dos', null],
          ],
        ),
      );
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({ type: 'AREA', status: 'LISTO', rowCount: 2 });
      expect(await db.select().from(catalogEntries)).toHaveLength(0);
      expect((await apply(up.body.id)).body.status).toBe('APLICADO');
      const list = await request(srv())
        .get('/admin/imports/catalogs/AREA?cEmp=01')
        .set('Cookie', cookie);
      expect(list.body).toEqual([
        { code: 'A1', name: 'Area Uno', active: true },
        { code: 'A2', name: 'Area Dos', active: true },
      ]);
    });

    it('CCOSTO: un código repetido con descripciones distintas detiene el lote y no elige una', async () => {
      await company();
      const up = await uploadCatalog(
        'CCOSTO',
        await sheet(
          ['C_COS', 'CCOSTO'],
          [
            ['FA1403', 'Producción'],
            ['FA1403', 'Producci�n'],
            ['FB1', 'Otro'],
          ],
        ),
      );
      expect(up.body.status).toBe('OBSERVADO');
      expect(await errorsOf(up.body.id)).toEqual([
        expect.objectContaining({ rule: 'código repetido con descripciones distintas' }),
      ]);
      expect((await apply(up.body.id)).status).toBe(409);
      expect(await db.select().from(catalogEntries)).toHaveLength(0);
    });

    it('una fila repetida idéntica se conserva una vez con advertencia', async () => {
      await company();
      const up = await uploadCatalog(
        'CARGO',
        await sheet(
          ['C_CAR', 'CARGO'],
          [
            ['C1', 'Analista'],
            ['C1', 'Analista'],
          ],
        ),
      );
      expect(up.body).toMatchObject({ status: 'LISTO', rowCount: 1 });
      expect(up.body.stats.warnings).toBe(1);
    });

    it('TIPO_CONTRATO es global, conserva el cero inicial y rechaza códigos numéricos', async () => {
      const ok = await uploadCatalog(
        'TIPO_CONTRATO',
        await sheet(
          ['TIPO_CONTRATO', 'NOMCONTRATO'],
          [
            ['01', 'Indefinido'],
            ['02', 'Fijo'],
          ],
        ),
        {},
      );
      expect(ok.body.status).toBe('LISTO');
      await apply(ok.body.id);
      expect((await db.select().from(catalogEntries)).map((e) => e.code).sort()).toEqual([
        '01',
        '02',
      ]);
      const bad = await uploadCatalog(
        'TIPO_CONTRATO',
        await sheet(['TIPO_CONTRATO', 'NOMCONTRATO'], [[1, 'Indefinido']]),
        {},
      );
      expect(bad.body.status).toBe('OBSERVADO');
    });

    it('exige una empresa existente para catálogos por empresa', async () => {
      const buf = await sheet(['C_ARE', 'NOMAREA'], [['A1', 'Uno']]);
      expect((await uploadCatalog('AREA', buf, {})).status).toBe(400);
      expect((await uploadCatalog('AREA', buf, { cEmp: '99' })).status).toBe(422);
    });

    it('rechaza catálogo desconocido, encabezados incorrectos y archivos que no son xlsx', async () => {
      await company();
      expect((await uploadCatalog('OTRO', await sheet(['A'], []))).status).toBe(404);
      const bad = await uploadCatalog('AREA', await sheet(['C_ARE', 'X'], [['A1', 'Uno']]));
      expect(bad.body.status).toBe('OBSERVADO');
      expect((await errorsOf(bad.body.id)).map((e) => e.rule)).toEqual(
        expect.arrayContaining(['columna no reconocida', 'columna obligatoria ausente']),
      );
      expect((await uploadCatalog('AREA', Buffer.from('no es excel'))).status).toBe(400);
    });

    it('un cambio de nombre conserva el historial y el mismo archivo no se aplica dos veces', async () => {
      await company();
      const first = await sheet(['C_ARE', 'NOMAREA'], [['A1', 'Ventas']]);
      const a = await uploadCatalog('AREA', first);
      await apply(a.body.id);
      expect((await uploadCatalog('AREA', first)).status).toBe(409);
      const b = await uploadCatalog(
        'AREA',
        await sheet(
          ['C_ARE', 'NOMAREA'],
          [
            ['A1', 'Comercial'],
            ['A9', 'Nueva'],
          ],
        ),
      );
      expect(b.body.stats).toMatchObject({ renamed: 1, created: 1 });
      await apply(b.body.id);
      const hist = await db.select().from(catalogEntryHistory);
      expect(hist).toHaveLength(1);
      expect(hist[0]).toMatchObject({ oldName: 'Ventas', newName: 'Comercial' });
      const [entry] = await db
        .select()
        .from(catalogEntries)
        .where(sql`code = 'A1'`);
      expect(entry?.name).toBe('Comercial');
    });

    it('las ausencias del archivo se reportan y no se desactivan', async () => {
      await company();
      await apply(
        (
          await uploadCatalog(
            'AREA',
            await sheet(
              ['C_ARE', 'NOMAREA'],
              [
                ['A1', 'Uno'],
                ['A2', 'Dos'],
              ],
            ),
          )
        ).body.id,
      );
      const up = await uploadCatalog('AREA', await sheet(['C_ARE', 'NOMAREA'], [['A1', 'Uno']]));
      expect(up.body.stats.missingInFile).toBe(1);
      await apply(up.body.id);
      expect(
        (
          await db
            .select()
            .from(catalogEntries)
            .where(sql`code = 'A2'`)
        )[0]?.active,
      ).toBe(true);
    });

    it('aplicar en paralelo deja un solo resultado', async () => {
      await company();
      const up = await uploadCatalog(
        'AREA',
        await sheet(
          ['C_ARE', 'NOMAREA'],
          [
            ['A1', 'Uno'],
            ['A2', 'Dos'],
          ],
        ),
      );
      const [x, y] = await Promise.all([apply(up.body.id), apply(up.body.id)]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect(await db.select().from(catalogEntries)).toHaveLength(2);
    });

    it('si la empresa se desactiva entre la vista previa y la aplicación, el lote falla sin cambios', async () => {
      await company();
      const up = await uploadCatalog('AREA', await sheet(['C_ARE', 'NOMAREA'], [['A1', 'Uno']]));
      await db.update(companies).set({ active: false });
      expect((await apply(up.body.id)).status).toBe(422);
      expect(await db.select().from(catalogEntries)).toHaveLength(0);
      expect((await db.select().from(importBatches))[0]?.status).toBe('FALLIDO');
    });
  });

  describe('EMPLEADOS validado contra los catálogos', () => {
    const row = (over: Record<string, Cell> = {}) => {
      const base: Record<string, Cell> = {
        C_EMP: '01',
        N_IDE: '1000000001',
        NOMBRE: 'ANA',
        C_COS: 'CC1',
        CCOSTO: 'Costo Uno',
        S_ACT: 1000,
        N_CONT: '1',
        C_CAR: 'CA1',
        C_AREA: 'A1',
        FEC_NAC: new Date(Date.UTC(1990, 0, 2)),
        CARGO: 'Analista',
        AREA: 'Area Uno',
        HLIQ: 15,
        SEXO: 'F',
        F_INI: new Date(Date.UTC(2020, 0, 6)),
        TURNO: 'D',
        EST: 'V',
        EMAIL: 'ana@x.co',
        NOMBRES: 'ANA',
        APELLIDOS: 'P',
        CELULAR: null,
        PROFESION: null,
        NIVELEDUCATIVO: null,
        TIPO_CONTRATO: '01',
      };
      const merged = { ...base, ...over };
      return EMPLOYEE_COLUMNS.map((c) => merged[c] ?? null);
    };
    const seed = async () => {
      await db.insert(companies).values({ cEmp: '01', nombre: 'E', sigla: 'E', direccion: 'D' });
      await db.insert(catalogEntries).values([
        { type: 'AREA', cEmp: '01', code: 'A1', name: 'Area Uno' },
        { type: 'CCOSTO', cEmp: '01', code: 'CC1', name: 'Costo Uno' },
        { type: 'CARGO', cEmp: '01', code: 'CA1', name: 'Analista' },
        { type: 'TIPO_CONTRATO', cEmp: '', code: '01', name: 'Indefinido' },
      ]);
    };
    const uploadEmp = async (rows: Cell[][]) =>
      authed(request(srv()).post('/admin/imports/employees'))
        .field('sourceSystem', 'ERP')
        .field('responsible', 'GH')
        .attach('file', await sheet([...EMPLOYEE_COLUMNS], rows), { filename: 'e.xlsx' });

    it('acepta códigos publicados; descripciones distintas solo generan advertencia', async () => {
      await seed();
      const up = await uploadEmp([row({ AREA: 'Otro nombre' })]);
      expect(up.body.status).toBe('LISTO');
      expect(up.body.stats.warnings).toBe(1);
    });

    it('rechaza códigos inexistentes: empresa, área, centro de costo, cargo y tipo de contrato', async () => {
      await seed();
      const up = await uploadEmp([
        row({ C_AREA: 'ZZ' }),
        row({ N_IDE: '2', EMAIL: 'b@x.co', C_COS: 'ZZ' }),
        row({ N_IDE: '3', EMAIL: 'c@x.co', C_CAR: 'ZZ' }),
        row({ N_IDE: '4', EMAIL: 'd@x.co', TIPO_CONTRATO: '09' }),
        row({ N_IDE: '5', EMAIL: 'e@x.co', C_EMP: '99' }),
      ]);
      expect(up.body.status).toBe('OBSERVADO');
      const cols = (await errorsOf(up.body.id)).map((e) => e.column).sort();
      expect(cols).toEqual(['C_AREA', 'C_COS', 'C_CAR', 'C_EMP', 'TIPO_CONTRATO'].sort());
    });

    it('sin catálogos publicados no se puede importar empleados', async () => {
      const up = await uploadEmp([row()]);
      expect(up.body.status).toBe('OBSERVADO');
    });

    it('si un catálogo cambia entre la vista previa y la aplicación, no se aplica', async () => {
      await seed();
      const up = await uploadEmp([row()]);
      expect(up.body.status).toBe('LISTO');
      await db
        .update(catalogEntries)
        .set({ active: false })
        .where(sql`type = 'AREA'`);
      expect((await apply(up.body.id)).status).toBe(422);
      expect(await db.select().from(employeeSnapshots)).toHaveLength(0);
    });
  });
});
