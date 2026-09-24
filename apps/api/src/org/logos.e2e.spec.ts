import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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
  companyLogos,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { NOMINA_COLUMNS } from '../payroll/nomina.parser';
import { inspectImage } from './logos.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(width: number, height: number, rgb: [number, number, number] = [200, 30, 30]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function pdfImages(
  buf: Buffer,
): Promise<{ width: number; height: number; x: number; y: number; w: number; h: number }[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts =
    join(process.cwd(), '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: fonts,
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  const found: { width: number; height: number; x: number; y: number; w: number; h: number }[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === pdfjs.OPS.transform) ctm = args as number[];
    if (fn === pdfjs.OPS.paintImageXObject) {
      const id = args[0] as string;
      const img = await new Promise<{ width: number; height: number }>((resolve) =>
        page.objs.get(id, resolve),
      );
      found.push({
        width: img.width,
        height: img.height,
        x: ctm[4] ?? 0,
        y: ctm[5] ?? 0,
        w: ctm[0] ?? 0,
        h: ctm[3] ?? 0,
      });
    }
  }
  return found;
}

describe('inspección de imágenes', () => {
  it('lee dimensiones de PNG y JPEG y rechaza lo demás', () => {
    expect(inspectImage(png(120, 80))).toEqual({
      contentType: 'image/png',
      width: 120,
      height: 80,
    });
    expect(inspectImage(jpegHeader(300, 200))).toEqual({
      contentType: 'image/jpeg',
      width: 300,
      height: 200,
    });
    expect(inspectImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(inspectImage(Buffer.alloc(0))).toBeNull();
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe.skipIf(!url)('logo de la empresa (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  type Sess = { cookie: string; csrf: string };
  let hr: Sess = { cookie: '', csrf: '' };
  let companyId = '';

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
      sql`TRUNCATE audit_logs, company_logos, payroll_download_audit, payroll_lines, payroll_versions, import_batch_rows, import_batches, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    const [c] = await db
      .insert(companies)
      .values({ cEmp: 'GA', nombre: 'Empresa Uno', sigla: 'EU', direccion: 'Calle 1' })
      .returning({ id: companies.id });
    companyId = c?.id ?? '';
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
  const upload = (buf: Buffer, s: Sess = hr, name = 'logo.png') =>
    request(srv())
      .post(`/admin/companies/${companyId}/logo`)
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .attach('file', buf, { filename: name });
  const bytes = (path: string, s: Sess = hr) =>
    request(srv())
      .get(path)
      .set('Cookie', s.cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('sin logo propio sirve el genérico y lo identifica como tal', async () => {
    const res = await bytes(`/admin/companies/${companyId}/logo`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-logo-source']).toBe('default');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(inspectImage(res.body as Buffer)).toMatchObject({ width: 400, height: 400 });
    expect(
      (await request(srv()).get(`/admin/companies/${companyId}/logos`).set('Cookie', hr.cookie))
        .body,
    ).toEqual([]);
  });

  it('sube un PNG, crea la versión 1 activa y lo sirve con su huella', async () => {
    const file = png(120, 90);
    const up = await upload(file);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ version: 1, contentType: 'image/png', width: 120, height: 90 });
    const res = await bytes(`/admin/companies/${companyId}/logo`);
    expect(res.headers['x-logo-source']).toBe('custom');
    expect(res.headers['etag']).toMatch(/^"[0-9a-f]{64}"$/);
    expect((res.body as Buffer).equals(file)).toBe(true);
  });

  it('acepta JPEG por su cabecera y rechaza formatos, tamaños y dimensiones no permitidos', async () => {
    expect((await upload(jpegHeader(200, 100), hr, 'logo.jpg')).status).toBe(201);
    expect((await upload(Buffer.from('GIF89a' + 'x'.repeat(100)))).status).toBe(422);
    expect(
      (
        await upload(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>'),
          hr,
          'logo.svg',
        )
      ).status,
    ).toBe(422);
    expect((await upload(png(32, 32))).status).toBe(422);
    expect((await upload(png(64, 3000))).status).toBe(422);
    const big = Buffer.concat([png(100, 100), Buffer.alloc(600 * 1024)]);
    expect((await upload(big)).status).toBe(413);
    expect(await db.select().from(companyLogos)).toHaveLength(1);
    const audit = await db.execute(
      sql`select result from audit_logs where action = 'LOGO_UPLOAD' order by at`,
    );
    expect(audit.rows.map((r) => r.result)).toEqual([
      'SUCCESS',
      'INVALID_IMAGE',
      'INVALID_IMAGE',
      'INVALID_DIMENSIONS',
      'INVALID_DIMENSIONS',
    ]);
  });

  it('cada carga crea una versión nueva, deja una sola activa y permite volver a una anterior o al genérico', async () => {
    const a = png(100, 100, [10, 10, 200]);
    const b = png(110, 110, [10, 200, 10]);
    const v1 = await upload(a);
    const v2 = await upload(b);
    expect([v1.body.version, v2.body.version]).toEqual([1, 2]);
    const list = await request(srv())
      .get(`/admin/companies/${companyId}/logos`)
      .set('Cookie', hr.cookie);
    expect(
      list.body.map((l: { version: number; active: boolean }) => `${l.version}:${l.active}`),
    ).toEqual(['2:true', '1:false']);
    expect(JSON.stringify(list.body)).not.toContain('"data"');

    const act = await request(srv())
      .post(`/admin/companies/${companyId}/logo/${v1.body.id}/activate`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf);
    expect(act.status).toBe(204);
    expect(((await bytes(`/admin/companies/${companyId}/logo`)).body as Buffer).equals(a)).toBe(
      true,
    );

    const reset = await request(srv())
      .post(`/admin/companies/${companyId}/logo/reset`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf);
    expect(reset.status).toBe(204);
    expect((await bytes(`/admin/companies/${companyId}/logo`)).headers['x-logo-source']).toBe(
      'default',
    );
    expect(await db.select().from(companyLogos)).toHaveLength(2);
  });

  it('dos cargas simultáneas dejan versiones distintas y una sola activa', async () => {
    const [x, y] = await Promise.all([
      upload(png(100, 100, [1, 2, 3])),
      upload(png(101, 101, [3, 2, 1])),
    ]);
    expect([x.status, y.status]).toEqual([201, 201]);
    const rows = await db.select().from(companyLogos);
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
    expect(rows.filter((r) => r.active)).toHaveLength(1);
  });

  it('exige rol de administrador, CSRF y reautenticación; valida identificadores', async () => {
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
    expect((await upload(png(100, 100), emp)).status).toBe(403);
    expect(
      (await request(srv()).get(`/admin/companies/${companyId}/logo`).set('Cookie', emp.cookie))
        .status,
    ).toBe(403);
    expect((await upload(png(100, 100), { cookie: hr.cookie, csrf: 'x'.repeat(64) })).status).toBe(
      403,
    );
    expect(
      (
        await request(srv())
          .post(`/admin/companies/${companyId}/logo`)
          .attach('file', png(100, 100), { filename: 'a.png' })
      ).status,
    ).toBe(401);
    expect(
      (await request(srv()).get('/admin/companies/no-uuid/logo').set('Cookie', hr.cookie)).status,
    ).toBe(400);
    expect(
      (
        await request(srv())
          .get('/admin/companies/00000000-0000-4000-8000-000000000000/logo')
          .set('Cookie', hr.cookie)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(srv())
          .post(`/admin/companies/${companyId}/logo`)
          .set('Cookie', hr.cookie)
          .set('X-CSRF-Token', hr.csrf)
      ).status,
    ).toBe(400);
    await db.execute(
      sql`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE account_id in (select id from accounts where email = 'hr@x.co')`,
    );
    expect((await upload(png(100, 100))).status).toBe(403);
  });

  describe('en el volante PDF', () => {
    const line = {
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
    } as const;

    async function publishAndLogin() {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Hoja 1');
      ws.addRow([...NOMINA_COLUMNS]);
      ws.addRow(
        NOMINA_COLUMNS.map(
          (c) => (line as Record<string, unknown>)[c] ?? null,
        ) as ExcelJS.CellValue[],
      );
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
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
        .field('responsible', 'N')
        .attach('file', buf, { filename: 'NOMINA.xlsx' });
      await request(srv())
        .post(`/admin/imports/${up.body.id}/apply`)
        .set('Cookie', hr.cookie)
        .set('X-CSRF-Token', hr.csrf);
      return login('ana@x.co');
    }

    it('el volante usa el logo genérico por defecto y el propio cuando se carga, en la esquina superior izquierda', async () => {
      const ana = await publishAndLogin();
      const before = await pdfImages(
        (await bytes('/me/payroll/202609/1/1/pdf?mode=SIN_AJUSTE', ana)).body as Buffer,
      );
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ width: 400, height: 400 });
      expect(before[0]?.x).toBeCloseTo(40, 0);
      expect(before[0]?.w).toBeCloseTo(60, 0);

      await upload(png(100, 100, [10, 10, 200]));
      const after = await pdfImages(
        (await bytes('/me/payroll/202609/1/1/pdf?mode=SIN_AJUSTE', ana)).body as Buffer,
      );
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ width: 100, height: 100 });
    });

    it('un logo dañado no impide generar el volante: cae al genérico', async () => {
      const ana = await publishAndLogin();
      await db.insert(companyLogos).values({
        companyId,
        version: 1,
        contentType: 'image/jpeg',
        data: jpegHeader(200, 200),
        sha256: 'x',
        width: 200,
        height: 200,
        active: true,
        uploadedBy:
          (
            await db
              .select()
              .from(accounts)
              .where(sql`email = 'hr@x.co'`)
          )[0]?.id ?? '',
      });
      const res = await bytes('/me/payroll/202609/1/1/pdf?mode=SIN_AJUSTE', ana);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('el genérico incluido existe y es un PNG válido', () => {
      const file = readFileSync(join(__dirname, '..', '..', 'assets', 'logo-generico.png'));
      expect(inspectImage(file)).toMatchObject({
        contentType: 'image/png',
        width: 400,
        height: 400,
      });
    });
  });
});
