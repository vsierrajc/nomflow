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
  companies,
  employeeSnapshots,
  payrollConcepts,
  roleAssignments,
} from '../db/schema';
import { NOMINA_COLUMNS } from './nomina.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Cell = string | number | null;

async function xlsx(columns: string[], rows: Cell[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(columns);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const CONCEPT_COLS = ['CONCEPTO', 'NOMCONCEPTO', 'UNIDAD'];

async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    text += c.items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  }
  return text.replace(/\s+/g, ' ');
}

describe.skipIf(!url)('catálogo de conceptos de nómina (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  type Sess = { cookie: string; csrf: string };
  let hr: Sess = { cookie: '', csrf: '' };

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
      sql`TRUNCATE audit_logs, payroll_download_audit, payroll_lines, payroll_versions, payroll_concepts, import_batch_rows, import_batches, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
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
    await db
      .insert(roleAssignments)
      .values({ accountId: a?.id ?? '', role: 'SYSTEM_ADMIN', validFrom: '2020-01-01' });
    hr = await login('hr@x.co');
  });

  const srv = () => app.getHttpServer();
  const post = (path: string, body: object, s: Sess = hr) =>
    request(srv()).post(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const put = (path: string, body: object, s: Sess = hr) =>
    request(srv()).put(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
  const upload = (buf: Buffer, s: Sess = hr) =>
    request(srv())
      .post('/admin/imports/concepts')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .field('sourceSystem', 'ERP')
      .field('responsible', 'Nómina')
      .attach('file', buf, { filename: 'conceptos.xlsx' });
  const apply = (id: string) => post(`/admin/imports/${id}/apply`, {});

  describe('importación', () => {
    it('carga conceptos conservando ceros iniciales y unidades, y consulta con búsqueda', async () => {
      const up = await upload(
        await xlsx(CONCEPT_COLS, [
          ['062', 'AJUSTE FONDO DE SOLIDARIDAD', 'PES'],
          ['112', 'HORAS EXTRA', 'hrs'],
          ['142', 'OTRO', 'PES'],
        ]),
      );
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({ type: 'CONCEPTO', status: 'LISTO', rowCount: 3 });
      expect(up.body.stats).toMatchObject({ created: 3, units: ['HRS', 'PES'] });
      expect(await db.select().from(payrollConcepts)).toHaveLength(0);
      expect((await apply(up.body.id)).body.status).toBe('APLICADO');
      const list = await request(srv())
        .get('/admin/payroll-concepts?q=fondo')
        .set('Cookie', hr.cookie);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({
        code: '062',
        unit: 'PES',
        active: true,
        version: 1,
      });
      const byUnit = await request(srv())
        .get('/admin/payroll-concepts?unit=HRS')
        .set('Cookie', hr.cookie);
      expect(byUnit.body.items.map((i: { code: string }) => i.code)).toEqual(['112']);
    });

    it('rechaza códigos numéricos, unidad inválida, encabezados y repetidos con datos distintos', async () => {
      const up = await upload(
        await xlsx(CONCEPT_COLS, [
          [62, 'NUM', 'PES'],
          ['A1', 'SIN UNIDAD', ''],
          ['A2', 'UNIDAD MALA', 'pe s!'],
          ['A3', 'UNO', 'PES'],
          ['A3', 'DOS', 'PES'],
        ]),
      );
      expect(up.body.status).toBe('OBSERVADO');
      expect(up.body.errorCount).toBe(4);
      const bad = await upload(await xlsx(['CONCEPTO', 'NOMCONCEPTO'], [['1', 'x']]));
      expect(bad.body.status).toBe('OBSERVADO');
      expect((await upload(Buffer.from('no es excel'))).status).toBe(400);
      expect(await db.select().from(payrollConcepts)).toHaveLength(0);
    });

    it('una fila repetida idéntica se conserva una vez; el mismo archivo aplicado no se repite', async () => {
      const buf = await xlsx(CONCEPT_COLS, [
        ['1', 'UNO', 'PES'],
        ['1', 'UNO', 'PES'],
      ]);
      const up = await upload(buf);
      expect(up.body).toMatchObject({ status: 'LISTO', rowCount: 1 });
      await apply(up.body.id);
      expect((await upload(buf)).status).toBe(409);
    });

    it('un cambio de nombre o unidad actualiza y sube la versión; las ausencias no se desactivan', async () => {
      await apply(
        (
          await upload(
            await xlsx(CONCEPT_COLS, [
              ['1', 'UNO', 'PES'],
              ['2', 'DOS', 'HRS'],
            ]),
          )
        ).body.id,
      );
      const up = await upload(await xlsx(CONCEPT_COLS, [['1', 'UNO CAMBIADO', 'HRS']]));
      expect(up.body.stats).toMatchObject({ changed: 1, missingInFile: 1 });
      await apply(up.body.id);
      const [one] = await db
        .select()
        .from(payrollConcepts)
        .where(sql`code = '1'`);
      expect(one).toMatchObject({ name: 'UNO CAMBIADO', unit: 'HRS', version: 2 });
      expect(
        (
          await db
            .select()
            .from(payrollConcepts)
            .where(sql`code = '2'`)
        )[0]?.active,
      ).toBe(true);
    });

    it('aplicar en paralelo deja un solo resultado', async () => {
      const up = await upload(await xlsx(CONCEPT_COLS, [['1', 'UNO', 'PES']]));
      const [a, b] = await Promise.all([apply(up.body.id), apply(up.body.id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });
  });

  describe('CRUD', () => {
    it('crea, evita duplicados, valida y consulta las unidades conocidas', async () => {
      const c = await post('/admin/payroll-concepts', {
        code: '500',
        name: '  Bono   de  prueba ',
        unit: 'pes',
      });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({
        code: '500',
        name: 'Bono de prueba',
        unit: 'PES',
        version: 1,
      });
      expect(
        (await post('/admin/payroll-concepts', { code: '500', name: 'x', unit: 'PES' })).status,
      ).toBe(409);
      expect(
        (await post('/admin/payroll-concepts', { code: '501', name: 'x', unit: 'no válida' }))
          .status,
      ).toBe(400);
      expect(
        (await post('/admin/payroll-concepts', { code: '', name: 'x', unit: 'PES' })).status,
      ).toBe(400);
      const units = await request(srv())
        .get('/admin/payroll-concepts/units')
        .set('Cookie', hr.cookie);
      expect(units.body).toEqual(
        expect.arrayContaining([
          { code: 'HRS', label: 'horas' },
          { code: 'PES', label: 'pesos' },
        ]),
      );
    });

    it('modifica con control de versión, desactiva sin borrar y audita', async () => {
      const c = await post('/admin/payroll-concepts', { code: '500', name: 'Uno', unit: 'PES' });
      const ok = await put(`/admin/payroll-concepts/${c.body.id}`, {
        name: 'Uno mod',
        unit: 'HRS',
        active: true,
        version: 1,
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ name: 'Uno mod', unit: 'HRS', version: 2 });
      const stale = await put(`/admin/payroll-concepts/${c.body.id}`, {
        name: 'x',
        unit: 'PES',
        active: true,
        version: 1,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      const off = await put(`/admin/payroll-concepts/${c.body.id}`, {
        name: 'Uno mod',
        unit: 'HRS',
        active: false,
        version: 2,
      });
      expect(off.body.active).toBe(false);
      expect(await db.select().from(payrollConcepts)).toHaveLength(1);
      expect(
        (
          await put('/admin/payroll-concepts/00000000-0000-4000-8000-000000000000', {
            name: 'x',
            unit: 'PES',
            active: true,
            version: 1,
          })
        ).status,
      ).toBe(404);
      const active = await request(srv())
        .get('/admin/payroll-concepts?active=false')
        .set('Cookie', hr.cookie);
      expect(active.body.total).toBe(1);
      const audit = await db.execute(
        sql`select action from audit_logs where action like 'CONCEPT_%'`,
      );
      expect(audit.rows.map((r) => r.action).sort()).toEqual([
        'CONCEPT_CREATE',
        'CONCEPT_UPDATE',
        'CONCEPT_UPDATE',
      ]);
    });

    it('pagina y busca sin permitir inyección de comodines', async () => {
      for (let i = 0; i < 5; i++)
        await post('/admin/payroll-concepts', {
          code: `C${i}`,
          name: `Concepto ${i}`,
          unit: 'PES',
        });
      const p = await request(srv())
        .get('/admin/payroll-concepts?page=2&pageSize=2')
        .set('Cookie', hr.cookie);
      expect(p.body).toMatchObject({ total: 5, page: 2, pageSize: 2 });
      expect(p.body.items.map((i: { code: string }) => i.code)).toEqual(['C2', 'C3']);
      expect(
        (await request(srv()).get('/admin/payroll-concepts?q=%25').set('Cookie', hr.cookie)).body
          .total,
      ).toBe(0);
      expect(
        (await request(srv()).get('/admin/payroll-concepts?pageSize=999').set('Cookie', hr.cookie))
          .status,
      ).toBe(400);
    });
  });

  describe('unidades en el volante', () => {
    const line = (o: Record<string, Cell> = {}) => ({
      PER: '202609',
      N_LIQ: 1,
      N_IDE: '1000000001',
      CONTRATO: '1',
      NOMBRE: 'ANA',
      C_CON: '100',
      CONCEPTO: 'Salario',
      SLRIO: '1000',
      CANT: 15,
      DED: null,
      DEV: '100',
      TERCERO: null,
      ...o,
    });
    const nomina = async (rows: Record<string, Cell>[]) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Hoja 1');
      ws.addRow([...NOMINA_COLUMNS]);
      for (const r of rows) ws.addRow(NOMINA_COLUMNS.map((c) => r[c] ?? null));
      return Buffer.from(await wb.xlsx.writeBuffer());
    };

    it('muestra la cantidad con su unidad, sin unidad si el concepto no está y avisa en la vista previa', async () => {
      await post('/admin/payroll-concepts', { code: '100', name: 'Salario', unit: 'HRS' });
      await post('/admin/payroll-concepts', { code: '101', name: 'Bono', unit: 'PES' });
      await db
        .insert(companies)
        .values({ cEmp: 'GA', nombre: 'Empresa', sigla: 'E', direccion: 'D' });
      await db.insert(employeeSnapshots).values({
        nIde: '1000000001',
        nCont: '1',
        email: 'ana@x.co',
        est: 'V',
        nombre: 'ANA',
        cEmp: 'GA',
      });
      await db.insert(accounts).values({
        nIde: '1000000001',
        email: 'ana@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      });

      const up = await request(srv())
        .post('/admin/imports/payroll')
        .set('Cookie', hr.cookie)
        .set('X-CSRF-Token', hr.csrf)
        .field('per', '202609')
        .field('nLiq', '1')
        .field('sourceSystem', 'ERP')
        .field('responsible', 'Nómina')
        .attach(
          'file',
          await nomina([
            line({ C_CON: '100', CANT: 15 }),
            line({ C_CON: '101', CANT: 20000, CONCEPTO: 'Bono' }),
            line({ C_CON: '777', CANT: 3, CONCEPTO: 'Sin catálogo' }),
          ]),
          { filename: 'NOMINA.xlsx' },
        );
      expect(up.body.status).toBe('LISTO');
      expect(up.body.stats.unknownConcepts).toBe(1);
      await apply(up.body.id);

      const ana = await login('ana@x.co');
      const res = await request(srv())
        .get('/me/payroll/202609/1/1/pdf?mode=SIN_AJUSTE')
        .set('Cookie', ana.cookie)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      const text = await pdfText(res.body as Buffer);
      expect(text).toContain('15 horas');
      expect(text).toContain('20.000 pesos');
      expect(text).toMatch(/Sin catálogo 3 /);
      expect(text).not.toContain('3 horas');
      expect(text).not.toContain('3 pesos');
    });
  });
});
