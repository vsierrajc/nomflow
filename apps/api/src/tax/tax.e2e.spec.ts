import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, employeeSnapshots, roleAssignments, taxCertificates } from '../db/schema';
import { parseFileName } from './tax.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);

describe('nombre de archivo', () => {
  it('extrae identificación y año', () => {
    expect(parseFileName('840695_2025.pdf')).toEqual({ nIde: '840695', year: 2025 });
    expect(parseFileName('840695_2025.PDF')).toEqual({ nIde: '840695', year: 2025 });
  });
  it('rechaza nombres inválidos', () => {
    for (const n of [
      '840695-2025.pdf',
      '840695_25.pdf',
      '../840695_2025.pdf',
      'a_2025.txt',
      '_2025.pdf',
    ])
      expect(parseFileName(n)).toBeNull();
  });
});

describe.skipIf(!url)('certificados de retención (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let inbox = '';
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
  async function account(nIde: string, email: string, role?: 'HR_ADMIN') {
    await db.insert(employeeSnapshots).values({ nIde, nCont: '1', email, est: 'V', nombre: nIde });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    if (role)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role, validFrom: '2020-01-01' });
    return login(email);
  }
  const put = (name: string, data: Buffer | string) => writeFile(join(inbox, name), data);
  const process = () =>
    request(app.getHttpServer())
      .post('/admin/tax-certificates/process')
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf);

  beforeEach(async () => {
    if (inbox) await rm(inbox, { recursive: true, force: true });
    inbox = await mkdtemp(join(tmpdir(), 'nomflow-tax-'));
    global.process.env.TAX_CERT_INBOX_DIR = inbox;
    await db.execute(
      sql`TRUNCATE tax_certificates, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    hr = await account('ADM', 'hr@x.co', 'HR_ADMIN');
  });

  it('carga, valida, versiona y mueve los archivos', async () => {
    await account('840695', 'e1@x.co');
    await put('840695_2025.pdf', pdf('a'));
    await put('999_2025.pdf', pdf('x')); // empleado inexistente
    await put('840695_2024.pdf', 'no es pdf');
    await put('malo.pdf', pdf('y'));
    const res = await process().expect(200);
    const by = Object.fromEntries(
      (res.body.results as { file: string; result: string }[]).map((r) => [r.file, r.result]),
    );
    expect(by).toEqual({
      '840695_2025.pdf': 'CARGADO',
      '999_2025.pdf': 'EMPLEADO_NO_EXISTE',
      '840695_2024.pdf': 'NO_ES_PDF',
      'malo.pdf': 'NOMBRE_INVALIDO',
    });
    expect((await readdir(inbox)).sort()).toEqual(['procesados', 'rechazados']);
    expect(await readdir(join(inbox, 'rechazados'))).toHaveLength(3);

    // mismo contenido: sin cambios; contenido nuevo: versión 2 y la 1 queda inactiva
    await put('840695_2025.pdf', pdf('a'));
    expect((await process()).body.results[0].result).toBe('SIN_CAMBIOS');
    await put('840695_2025.pdf', pdf('b'));
    expect((await process()).body.results[0].result).toBe('CARGADO');
    const rows = await db.select().from(taxCertificates);
    expect(rows.map((r) => [r.version, r.active]).sort()).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('el empleado ve y descarga solo el suyo', async () => {
    const e1 = await account('840695', 'e1@x.co');
    const e2 = await account('555', 'e2@x.co');
    await put('840695_2025.pdf', pdf('mio'));
    await put('555_2025.pdf', pdf('ajeno'));
    await process().expect(200);
    const list = await request(app.getHttpServer())
      .get('/me/tax-certificates')
      .set('Cookie', e1.cookie)
      .expect(200);
    expect(list.body.map((r: { year: number }) => r.year)).toEqual([2025]);
    const dl = await request(app.getHttpServer())
      .get('/me/tax-certificates/2025/pdf')
      .set('Cookie', e1.cookie)
      .buffer(true)
      .parse((r, cb) => {
        const c: Buffer[] = [];
        r.on('data', (d: Buffer) => c.push(d));
        r.on('end', () => cb(null, Buffer.concat(c)));
      })
      .expect(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect((dl.body as Buffer).toString()).toContain('mio');
    await request(app.getHttpServer())
      .get('/me/tax-certificates/2024/pdf')
      .set('Cookie', e1.cookie)
      .expect(404);
    await request(app.getHttpServer()).get('/me/tax-certificates').expect(401);
    expect(
      (
        await request(app.getHttpServer())
          .get('/me/tax-certificates/2025/pdf')
          .set('Cookie', e2.cookie)
      ).body.toString(),
    ).toContain('ajeno');
  });

  it('solo administración procesa y lista', async () => {
    const e1 = await account('840695', 'e1@x.co');
    await request(app.getHttpServer())
      .post('/admin/tax-certificates/process')
      .set('Cookie', e1.cookie)
      .set('X-CSRF-Token', e1.csrf)
      .expect(403);
    await request(app.getHttpServer())
      .get('/admin/tax-certificates')
      .set('Cookie', e1.cookie)
      .expect(403);
  });
});
