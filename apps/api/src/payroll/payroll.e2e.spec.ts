import { join } from 'node:path';
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
  importBatchRows,
  importBatches,
  payrollDownloadAudit,
  payrollLines,
  payrollVersions,
  roleAssignments,
} from '../db/schema';
import { NOMINA_COLUMNS } from './nomina.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Cell = string | number | null | { formula: string };
type Row = Partial<Record<(typeof NOMINA_COLUMNS)[number], Cell>>;

const line = (over: Row = {}): Row => ({
  PER: '202609',
  N_LIQ: 1,
  N_IDE: '1000000001',
  CONTRATO: '1',
  NOMBRE: 'ANA PRUEBA',
  C_CON: '100',
  CONCEPTO: 'Salario',
  SLRIO: '1500000.5',
  CANT: 15,
  DED: null,
  DEV: '750000.25',
  TERCERO: null,
  ...over,
});

async function xlsx(
  rows: Row[],
  columns: readonly string[] = NOMINA_COLUMNS,
  sheetName = 'Hoja 1',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow([...columns]);
  for (const r of rows) ws.addRow(columns.map((c) => r[c as keyof Row] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts =
    join(process.cwd(), '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: fonts,
    verbosity: 0,
  }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    text += content.items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  }
  return { text: text.replace(/\s+/g, ' '), pages: doc.numPages };
}

describe.skipIf(!url)('nómina y volantes PDF (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let hr = { cookie: '', csrf: '' };

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

  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  async function employee(nIde: string, email: string, nombre: string) {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email, est: 'V', nombre, cEmp: 'GA' });
    await db.insert(accounts).values({
      nIde,
      email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVA',
      mustChangePassword: false,
    });
    return login(email);
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, payroll_download_audit, payroll_lines, payroll_versions, import_batch_rows, import_batches, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db.insert(companies).values({
      cEmp: 'GA',
      nombre: 'Grupo Alimentario del Atlantico S.A.',
      sigla: 'GRALCO',
      direccion: 'CL 1 38 121',
    });
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
      .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
    hr = await login('hr@x.co');
  });

  const srv = () => app.getHttpServer();
  type Sess = { cookie: string; csrf: string };
  const upload = (buf: Buffer, fields: Record<string, string> = {}, s: Sess = hr) => {
    const r = request(srv())
      .post('/admin/imports/payroll')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .field('per', fields.per ?? '202609')
      .field('nLiq', fields.nLiq ?? '1')
      .field('sourceSystem', 'ERP')
      .field('responsible', 'Nómina');
    return r.attach('file', buf, { filename: 'NOMINA.xlsx' });
  };
  const apply = (id: string) =>
    request(srv())
      .post(`/admin/imports/${id}/apply`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf);
  const errorsOf = async (id: string) =>
    (await request(srv()).get(`/admin/imports/${id}/errors`).set('Cookie', hr.cookie)).body
      .errors as { rule: string; column: string }[];
  const publish = async (rows: Row[], fields?: Record<string, string>) => {
    const up = await upload(await xlsx(rows), fields);
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('LISTO');
    expect((await apply(up.body.id)).status).toBe(200);
    return up.body.id as string;
  };
  const pdf = (s: Sess, path: string) =>
    request(srv())
      .get(path)
      .set('Cookie', s.cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  describe('importación', () => {
    it('valida y deja LISTO sin publicar; al aplicar persiste con sumas exactas', async () => {
      const rows = [
        line({ C_CON: '100', DEV: '0.1' }),
        line({ C_CON: '101', CONCEPTO: 'Horas extra', DEV: '0.2' }),
        line({ C_CON: '200', CONCEPTO: 'Salud', DEV: null, DED: '0.05' }),
        line({ N_IDE: '1000000002', NOMBRE: 'LUIS', DEV: '1000.4' }),
      ];
      const up = await upload(await xlsx(rows));
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({ type: 'NOMINA', status: 'LISTO', rowCount: 4 });
      expect(up.body.stats).toMatchObject({
        people: 2,
        vouchers: 2,
        totalDev: '1000.700000',
        totalDed: '0.050000',
      });
      expect(await db.select().from(payrollVersions)).toHaveLength(0);

      const res = await apply(up.body.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APLICADO');
      const [v] = await db.select().from(payrollVersions);
      expect(v).toMatchObject({
        per: '202609',
        nLiq: 1,
        version: 1,
        status: 'PUBLICADA',
        rowCount: 4,
        totalDev: '1000.700000',
        totalDed: '0.050000',
      });
      expect(await db.select().from(payrollLines)).toHaveLength(4);
    });

    it('acepta reversos negativos, importes nulos y líneas idénticas sin deduplicar', async () => {
      const up = await upload(
        await xlsx([
          line({ DEV: '-1.2' }),
          line({ DEV: null, DED: null }),
          line({ DEV: '5' }),
          line({ DEV: '5' }),
        ]),
      );
      expect(up.body.status).toBe('LISTO');
      await apply(up.body.id);
      const lines = await db.select().from(payrollLines);
      expect(lines).toHaveLength(4);
      expect(lines.filter((l) => l.dev === null)).toHaveLength(1);
    });

    it('rechaza período o liquidación distintos a los declarados y N_LIQ vacío', async () => {
      const up = await upload(
        await xlsx([
          line({ PER: '202608' }),
          line({ N_LIQ: 2 }),
          line({ N_LIQ: null }),
          line({ N_LIQ: 3 }),
        ]),
      );
      expect(up.body.status).toBe('OBSERVADO');
      const rules = (await errorsOf(up.body.id)).map((e) => e.rule);
      expect(rules).toEqual(
        expect.arrayContaining([
          'el período de la fila no coincide con el declarado para la carga',
          'la liquidación de la fila no coincide con la declarada para la carga',
          'valor obligatorio vacío',
          'N_LIQ debe ser 1 o 2',
        ]),
      );
      expect((await apply(up.body.id)).status).toBe(409);
      expect(await db.select().from(payrollVersions)).toHaveLength(0);
    });

    it('rechaza claves vacías, importes inválidos y salario negativo', async () => {
      const rows = [
        line({ N_IDE: null }),
        line({ CONTRATO: null }),
        line({ C_CON: null }),
        line({ DEV: '1,5' }),
        line({ DEV: '1e3' }),
        line({ DED: '1.1234567' }),
        line({ SLRIO: '-5' }),
        line({ CANT: 'abc' }),
      ];
      const up = await upload(await xlsx(rows));
      expect(up.body.status).toBe('OBSERVADO');
      expect(up.body.errorCount).toBeGreaterThanOrEqual(8);
      const dump = JSON.stringify(await errorsOf(up.body.id));
      for (const secret of ['1,5', '1e3', '1.1234567', 'abc']) expect(dump).not.toContain(secret);
    });

    it('marca para revisión un volante con SLRIO distintos y no elige uno', async () => {
      const up = await upload(
        await xlsx([line({ SLRIO: '1000000' }), line({ C_CON: '101', SLRIO: '1200000' })]),
      );
      expect(up.body.status).toBe('OBSERVADO');
      expect((await errorsOf(up.body.id))[0]?.rule).toContain('valores distintos de SLRIO');
    });

    it('rechaza encabezados incorrectos, fórmulas, archivos vacíos y no-xlsx', async () => {
      const noEmail = NOMINA_COLUMNS.filter((c) => c !== 'DEV');
      expect((await upload(await xlsx([line()], noEmail))).body.status).toBe('OBSERVADO');
      expect((await upload(await xlsx([line()], [...NOMINA_COLUMNS, 'EXTRA']))).body.status).toBe(
        'OBSERVADO',
      );
      const f = await upload(await xlsx([line({ CONCEPTO: { formula: '1+1' } })]));
      expect((await errorsOf(f.body.id))[0]?.rule).toBe('fórmula no permitida');
      expect((await upload(await xlsx([]))).body.status).toBe('OBSERVADO');
      expect((await upload(Buffer.from('no es excel'))).status).toBe(400);
    });

    it('valida el alcance declarado', async () => {
      const buf = await xlsx([line()]);
      expect((await upload(buf, { per: '202613' })).status).toBe(400);
      expect((await upload(buf, { per: '2026' })).status).toBe(400);
      expect((await upload(buf, { nLiq: '3' })).status).toBe(400);
    });

    it('el mismo archivo o el mismo contenido no crean una segunda versión', async () => {
      const rows = [line(), line({ C_CON: '101', DEV: '5' })];
      await publish(rows);
      expect((await upload(await xlsx(rows))).status).toBe(409);
      const reordered = await upload(await xlsx([...rows].reverse(), NOMINA_COLUMNS, 'Otra hoja'));
      expect(reordered.status).toBe(409);
      expect(reordered.body.code).toBe('SAME_CONTENT');
      expect(await db.select().from(payrollVersions)).toHaveLength(1);
    });

    it('una corrección crea la versión 2, deja una sola publicada y conserva la anterior', async () => {
      await publish([line({ DEV: '100' })]);
      await publish([line({ DEV: '150' })]);
      const versions = await db.select().from(payrollVersions).orderBy(payrollVersions.version);
      expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual([
        '1:REEMPLAZADA',
        '2:PUBLICADA',
      ]);
      expect(await db.select().from(payrollLines)).toHaveLength(2);
      const list = await request(srv())
        .get('/admin/imports/payroll/versions?per=202609')
        .set('Cookie', hr.cookie);
      expect(list.body).toHaveLength(2);
    });

    it('la misma liquidación en otra quincena o período es independiente', async () => {
      await publish([line()]);
      await publish([line({ N_LIQ: 2 })], { nLiq: '2' });
      await publish([line({ PER: '202610' })], { per: '202610' });
      expect(
        (await db.select().from(payrollVersions)).filter((v) => v.status === 'PUBLICADA'),
      ).toHaveLength(3);
    });

    it('si las sumas del staging no coinciden, se revierte todo y el lote queda FALLIDO', async () => {
      const up = await upload(await xlsx([line(), line({ C_CON: '101', DEV: '5' })]));
      await db.execute(
        sql`UPDATE import_batch_rows SET data = jsonb_set(data, '{dev}', '"999"') WHERE row_number = 2`,
      );
      const res = await apply(up.body.id);
      expect(res.status).toBe(422);
      expect(await db.select().from(payrollVersions)).toHaveLength(0);
      expect(await db.select().from(payrollLines)).toHaveLength(0);
      expect(
        (
          await db
            .select()
            .from(importBatches)
            .where(sql`id = ${up.body.id}`)
        )[0]?.status,
      ).toBe('FALLIDO');
    });

    it('aplicar dos veces en paralelo deja una sola versión', async () => {
      const up = await upload(await xlsx([line(), line({ C_CON: '101', DEV: '5' })]));
      const [a, b] = await Promise.all([apply(up.body.id), apply(up.body.id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await db.select().from(payrollVersions)).toHaveLength(1);
      expect(await db.select().from(payrollLines)).toHaveLength(2);
    });

    it('dos cargas distintas del mismo alcance en paralelo se serializan: v1 y v2, una sola publicada', async () => {
      const a = await upload(await xlsx([line({ DEV: '100' })]));
      const b = await upload(await xlsx([line({ DEV: '200' })]));
      const [x, y] = await Promise.all([apply(a.body.id), apply(b.body.id)]);
      expect([x.status, y.status]).toEqual([200, 200]);
      const versions = await db.select().from(payrollVersions);
      expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
      expect(versions.filter((v) => v.status === 'PUBLICADA')).toHaveLength(1);
    });

    it('exige rol HR_ADMIN, CSRF y reautenticación reciente', async () => {
      const buf = await xlsx([line()]);
      const emp = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      expect((await upload(buf, {}, emp)).status).toBe(403);
      expect((await upload(buf, {}, { cookie: hr.cookie, csrf: 'x'.repeat(64) })).status).toBe(403);
      await db.execute(
        sql`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE account_id in (select id from accounts where email = 'hr@x.co')`,
      );
      expect((await upload(buf)).status).toBe(403);
    });

    it('reporta empleados de la nómina sin correspondencia en EMPLEADOS', async () => {
      await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const up = await upload(await xlsx([line(), line({ N_IDE: '7777' })]));
      expect(up.body.stats.withoutEmployee).toBe(1);
    });
  });

  describe('volantes en PDF', () => {
    const rows = (): Row[] => [
      line({ C_CON: '100', CONCEPTO: 'Salario básico', CANT: 15, DEV: '1000.4' }),
      line({ C_CON: '101', CONCEPTO: 'Horas extra', CANT: 2.5, DEV: '500.4' }),
      line({ C_CON: '200', CONCEPTO: 'Aporte salud', CANT: null, DEV: null, DED: '100.2' }),
      line({ C_CON: '999', CONCEPTO: 'Reverso', CANT: null, DEV: '-1.2' }),
    ];
    const path = (contrato = '1', mode = 'SIN_AJUSTE') =>
      `/me/payroll/202609/1/${encodeURIComponent(contrato)}/pdf?mode=${mode}`;

    it('lista solo los volantes propios y sugiere el modo de la empresa', async () => {
      await publish([...rows(), line({ N_IDE: '1000000002', NOMBRE: 'LUIS' })]);
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const luis = await employee('1000000002', 'luis@x.co', 'LUIS PRUEBA');
      const a = await request(srv()).get('/me/payroll').set('Cookie', ana.cookie);
      expect(a.body.vouchers).toEqual([{ per: '202609', nLiq: 1, contrato: '1' }]);
      expect(a.body.defaultMode).toBe('ENTERO_SUPERIOR');
      expect(
        (await request(srv()).get('/me/payroll').set('Cookie', luis.cookie)).body.vouchers,
      ).toHaveLength(1);
      expect((await request(srv()).get('/me/payroll')).status).toBe(401);
    });

    it('SIN_AJUSTE: PDF válido con encabezado, importes originales, totales y neto', async () => {
      await publish(rows());
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const res = await pdf(ana, path());
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['cache-control']).toContain('no-store');
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe('%PDF-');

      const { text } = await pdfText(body);
      for (const s of [
        'Grupo Alimentario del Atlantico S.A.',
        'GRALCO',
        'CL 1 38 121',
        'ANA PRUEBA',
        '1000000001',
        'Contrato: 1',
        'septiembre de 2026 - primera quincena (liquidación 1)',
        'Salario básico',
        'Horas extra',
        'Aporte salud',
        '1.500.000,50',
        '1.000,40',
        '500,40',
        '100,20',
        '-1,20',
        '2,5',
        'SIN AJUSTE',
        'Versión de nómina: v1',
        'no corresponde a la fecha de pago',
      ]) {
        expect(text, s).toContain(s);
      }
      expect(text).toContain('1.499,60');
      expect(text).toContain('100,20 ');
      expect(text).toMatch(/Neto a pagar 1\.399,40/);
    });

    it('ENTERO_SUPERIOR: cada valor sube al entero, los totales cuadran con lo mostrado y se rotula', async () => {
      await publish(rows());
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const { text } = await pdfText((await pdf(ana, path('1', 'ENTERO_SUPERIOR'))).body as Buffer);
      expect(text).toContain('1.001');
      expect(text).toContain('501');
      expect(text).toContain('101');
      expect(text).toContain('1.500.001');
      expect(text).toMatch(/Totales 1\.501 101/);
      expect(text).toMatch(/Neto a pagar 1\.400/);
      expect(text).toContain('ENTERO SUPERIOR');
      expect(text).toContain('solo de presentación');
      expect(text).not.toContain('1.000,40');
    });

    it('los dos modos dan netos distintos sin cambiar la liquidación fuente', async () => {
      await publish(rows());
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const a = await pdfText((await pdf(ana, path('1', 'SIN_AJUSTE'))).body as Buffer);
      const b = await pdfText((await pdf(ana, path('1', 'ENTERO_SUPERIOR'))).body as Buffer);
      expect(a.text).not.toEqual(b.text);
      const [v] = await db.select().from(payrollVersions);
      expect(v?.totalDev).toBe('1499.600000');
      expect(
        (
          await db
            .select()
            .from(payrollLines)
            .where(sql`c_con = '100'`)
        )[0]?.dev,
      ).toBe('1000.400000');
    });

    it('no permite ver el volante de otra persona ni forzar identificación por la URL', async () => {
      await publish([
        ...rows(),
        line({ N_IDE: '1000000002', NOMBRE: 'LUIS', CONTRATO: '77', C_CON: '100', DEV: '9' }),
      ]);
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      expect((await pdf(ana, path('77'))).status).toBe(404);
      expect(
        (await pdf(ana, '/me/payroll/202609/1/1/pdf?mode=SIN_AJUSTE&nIde=1000000002')).status,
      ).toBe(200);
      const own = await pdfText(
        (await pdf(ana, '/me/payroll/202609/1/1/pdf?mode=SIN_AJUSTE&nIde=1000000002'))
          .body as Buffer,
      );
      expect(own.text).toContain('ANA PRUEBA');
      expect(own.text).not.toContain('LUIS');
    });

    it('valida modo, parámetros, período inexistente y sesión', async () => {
      await publish(rows());
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      expect((await pdf(ana, path('1', 'REDONDEO'))).status).toBe(400);
      expect((await pdf(ana, '/me/payroll/202609/1/1/pdf')).status).toBe(400);
      expect((await pdf(ana, '/me/payroll/2026/1/1/pdf?mode=SIN_AJUSTE')).status).toBe(400);
      expect((await pdf(ana, '/me/payroll/202609/3/1/pdf?mode=SIN_AJUSTE')).status).toBe(400);
      expect((await pdf(ana, '/me/payroll/202601/1/1/pdf?mode=SIN_AJUSTE')).status).toBe(404);
      expect((await request(srv()).get(path())).status).toBe(401);
    });

    it('audita cada descarga sin importes ni datos personales', async () => {
      await publish(rows());
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      await pdf(ana, path('1', 'SIN_AJUSTE'));
      await pdf(ana, path('1', 'ENTERO_SUPERIOR'));
      await pdf(ana, path('9'));
      await pdf(ana, path('1', 'MAL'));
      const audit = await db.select().from(payrollDownloadAudit);
      expect(audit.map((a) => `${a.mode}:${a.result}`).sort()).toEqual([
        'ENTERO_SUPERIOR:SUCCESS',
        'INVALIDO:INVALID_MODE',
        'SIN_AJUSTE:NOT_FOUND',
        'SIN_AJUSTE:SUCCESS',
      ]);
      const [v] = await db.select().from(payrollVersions);
      expect(audit.find((a) => a.result === 'SUCCESS')?.versionId).toBe(v?.id);
      const dump = JSON.stringify(audit);
      for (const secret of ['1000000001', '1500000', 'ANA PRUEBA'])
        expect(dump).not.toContain(secret);
    });

    it('tras una corrección, el empleado recibe siempre la versión publicada vigente', async () => {
      await publish([line({ DEV: '100' })]);
      await publish([line({ DEV: '150' })]);
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const { text } = await pdfText((await pdf(ana, path())).body as Buffer);
      expect(text).toContain('Versión de nómina: v2');
      expect(text).toContain('150,00');
      expect(text).not.toContain('Versión de nómina: v1');
    });

    it('muestra el SLRIO histórico aunque el salario actual del perfil sea otro', async () => {
      await publish([line({ SLRIO: '1234567.89', DEV: '10' })]);
      await db.insert(employeeSnapshots).values({
        nIde: '1000000001',
        nCont: '1',
        email: 'ana@x.co',
        est: 'V',
        nombre: 'ANA PRUEBA',
        cEmp: 'GA',
        sAct: '9999999',
      });
      await db.insert(accounts).values({
        nIde: '1000000001',
        email: 'ana@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      });
      const ana = await login('ana@x.co');
      const { text } = await pdfText((await pdf(ana, path())).body as Buffer);
      expect(text).toContain('1.234.567,89');
      expect(text).not.toContain('9.999.999');
    });

    it('un volante largo pagina y repite el encabezado; los textos raros no rompen el PDF', async () => {
      const many = Array.from({ length: 120 }, (_, i) =>
        line({
          C_CON: String(1000 + i),
          CONCEPTO: i === 0 ? `Concepto\u0007\u0000 ${'muy largo '.repeat(25)}` : `Concepto ${i}`,
          DEV: '10',
        }),
      );
      await publish(many);
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const res = await pdf(ana, path());
      expect(res.status).toBe(200);
      const { text, pages } = await pdfText(res.body as Buffer);
      expect(pages).toBeGreaterThanOrEqual(3);
      expect((text.match(/Devengado/g) ?? []).length).toBe(pages);
      expect(text).toContain('Concepto 119');
      expect(text).toContain('...');
      expect(text).not.toMatch(/(muy largo ){12}/);
      expect(text).toMatch(/Neto a pagar 1\.200,00/);
    });

    it('un volante sin empresa registrada igual se genera', async () => {
      await publish(rows());
      await db.execute(sql`TRUNCATE companies CASCADE`);
      const ana = await employee('1000000001', 'ana@x.co', 'ANA PRUEBA');
      const { text } = await pdfText((await pdf(ana, path())).body as Buffer);
      expect(text).toContain('NOMFLOW');
      expect(
        (await request(srv()).get('/me/payroll').set('Cookie', ana.cookie)).body.defaultMode,
      ).toBe('SIN_AJUSTE');
    });
  });

  it('el staging conserva las filas del lote aplicado para trazabilidad', async () => {
    const id = await publish([line(), line({ C_CON: '101', DEV: '5' })]);
    expect(
      await db
        .select()
        .from(importBatchRows)
        .where(sql`batch_id = ${id}`),
    ).toHaveLength(2);
  });
});
