import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, companies, roleAssignments } from '../db/schema';
import { renderVacationPdf } from '../leave/vacation-document.pdf';
import { renderLaborCertificatePdf } from '../certificates/labor-cert.pdf';

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

async function pageSize(buf: Buffer): Promise<[number, number]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts =
    join(process.cwd(), '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: fonts,
    verbosity: 0,
  }).promise;
  const v = (await doc.getPage(1)).getViewport({ scale: 1 });
  return [Math.round(v.width), Math.round(v.height)];
}

describe.skipIf(!url)('encabezado y pie de la empresa (HTTP + PostgreSQL)', () => {
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
      sql`TRUNCATE audit_logs, company_letterheads, company_logos, payroll_download_audit, payroll_lines, payroll_versions, import_batch_rows, import_batches, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
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
  const put = (kind: string, buf: Buffer, name = 'x.png') =>
    request(srv())
      .post(`/admin/companies/${companyId}/letterhead/${kind}`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf)
      .attach('file', buf, { filename: name });

  it('carga, consulta y quita el encabezado y el pie, y valida la imagen', async () => {
    await put('header', png(2550, 480)).expect(201);
    await put('footer', png(2550, 330)).expect(201);
    const st = await request(srv())
      .get(`/admin/companies/${companyId}/letterhead`)
      .set('Cookie', hr.cookie)
      .expect(200);
    expect(
      st.body.map((x: { kind: string; image: unknown }) => [x.kind, x.image !== null]),
    ).toEqual([
      ['HEADER', true],
      ['FOOTER', true],
    ]);
    const file = await request(srv())
      .get(`/admin/companies/${companyId}/letterhead/header`)
      .set('Cookie', hr.cookie)
      .expect(200);
    expect(file.headers['content-type']).toBe('image/png');

    // reemplazo: sigue habiendo una sola por posición
    await put('header', png(2550, 400)).expect(201);
    // demasiado alta, angosta o no es imagen
    await put('header', png(2550, 1200)).expect(422);
    await put('footer', png(800, 100)).expect(422);
    await put('footer', Buffer.from('<svg></svg>')).expect(422);
    await put('lateral', png(2550, 330)).expect(404);

    await request(srv())
      .delete(`/admin/companies/${companyId}/letterhead/header`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf)
      .expect(204);
    await request(srv())
      .get(`/admin/companies/${companyId}/letterhead/header`)
      .set('Cookie', hr.cookie)
      .expect(404);
  });

  it('los PDF salen en tamaño carta con el encabezado y el pie a todo el ancho', async () => {
    const lh = {
      header: { data: png(2550, 480), heightPt: 115 },
      footer: { data: png(2550, 330), heightPt: 79 },
    };
    const cert = await renderLaborCertificatePdf(
      {
        ref: 'R1',
        title: 'CERTIFICADO LABORAL',
        body: 'Texto del cuerpo.',
        company: { nombre: 'Empresa Uno', sigla: 'EU', direccion: 'Calle 1' },
        logo: null,
        letterhead: lh,
        docCode: 'GH-FO-001',
        docVersion: '01',
        docDate: '',
        signer: null,
        footerLines: [],
        issuedAt: new Date('2026-01-01T00:00:00Z'),
      },
      { compress: false },
    );
    const vac = await renderVacationPdf(
      {
        requestId: 'r',
        revision: 1,
        contentHash: 'h',
        employee: { name: 'Ana', nIde: '1', nCont: '1' },
        company: null,
        logo: null,
        letterhead: lh,
        start: '2026-02-02',
        end: '2026-02-06',
        calendarDiff: 4,
        businessDays: 5,
        returnDate: '2026-02-09',
        allocations: [],
        actions: [],
        approvedAt: new Date('2026-01-01T00:00:00Z'),
      },
      { compress: false },
    );
    for (const pdf of [cert, vac]) {
      const imgs = await pdfImages(pdf);
      expect(imgs).toHaveLength(2);
      expect(imgs[0]?.w).toBeCloseTo(612, 0);
      expect(imgs[0]?.y).toBeCloseTo(115.2, 0); // borde inferior del encabezado, contado desde arriba
      expect(imgs[1]?.w).toBeCloseTo(612, 0);
      expect(imgs[1]?.y).toBeCloseTo(792, 0); // el pie termina en el borde inferior de la hoja
      expect(await pageSize(pdf)).toEqual([612, 792]);
    }
    // sin imágenes también es carta
    expect(
      await pageSize(
        await renderVacationPdf(
          {
            requestId: 'r',
            revision: 1,
            contentHash: 'h',
            employee: { name: 'Ana', nIde: '1', nCont: '1' },
            company: null,
            logo: null,
            start: '2026-02-02',
            end: '2026-02-06',
            calendarDiff: 4,
            businessDays: 5,
            returnDate: '2026-02-09',
            allocations: [],
            actions: [],
            approvedAt: new Date('2026-01-01T00:00:00Z'),
          },
          { compress: false },
        ),
      ),
    ).toEqual([612, 792]);
  });
});
