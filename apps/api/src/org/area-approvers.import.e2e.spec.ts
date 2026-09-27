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
  companies,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { AREA_APPROVERS_COLUMNS } from './area-approvers.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Row = Record<(typeof AREA_APPROVERS_COLUMNS)[number], string | number | null>;
type Sess = { cookie: string; csrf: string };

const line = (over: Partial<Row> = {}): Row => ({
  CDGO_AREA: '10300',
  CDGO_EMPRSA: 'GA',
  NMBRE_AREA: 'FINANCIERA',
  JEFE: '84069561',
  DIRECTOR: '22493452',
  ...over,
});

async function xlsx(
  rows: Row[],
  columns: readonly string[] = AREA_APPROVERS_COLUMNS,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja 1');
  ws.addRow([...columns]);
  for (const r of rows) ws.addRow(columns.map((c) => r[c as keyof Row] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!url)('jefe y director de áreas por Excel (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
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
  async function person(nIde: string, email: string, nombre: string, cArea = '10300') {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email, est: 'V', nombre, cEmp: 'GA', cArea });
    await db.insert(accounts).values({
      nIde,
      email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVA',
      mustChangePassword: false,
    });
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, area_manager_assignments, catalog_entries, import_batch_rows, import_batches, companies, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    await db
      .insert(companies)
      .values({ cEmp: 'GA', nombre: 'Empresa', sigla: 'E', direccion: 'D' });
    await db
      .insert(catalogEntries)
      .values([{ type: 'AREA', cEmp: 'GA', code: '10300', name: 'FINANCIERA' }]);
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
    await person('84069561', 'jefe@x.co', 'Juan Jefe');
    await person('22493452', 'dir@x.co', 'Diana Directora');
  });

  const srv = () => app.getHttpServer();
  const upload = (buf: Buffer, s: Sess = hr) =>
    request(srv())
      .post('/admin/imports/area-approvers')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .field('sourceSystem', 'HR')
      .field('responsible', 'Gestión Humana')
      .attach('file', buf, { filename: 'AREAS.xlsx' });
  const apply = (id: string) =>
    request(srv())
      .post(`/admin/imports/${id}/apply`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf);
  const roleRows = () =>
    db
      .select({ role: roleAssignments.role, nIde: accounts.nIde })
      .from(roleAssignments)
      .innerJoin(accounts, sql`${accounts.id} = ${roleAssignments.accountId}`)
      .where(sql`${roleAssignments.role} in ('AREA_MANAGER', 'AREA_DIRECTOR')`);

  it('asigna jefe y director cuando ambas cédulas tienen cuenta activa', async () => {
    const up = await upload(await xlsx([line()])).expect(201);
    expect(up.body.status).toBe('LISTO');
    expect(up.body.stats).toMatchObject({ areas: 1, jefesAsignables: 1, directoresAsignables: 1 });
    await apply(up.body.id).expect(200);
    const rows = await roleRows();
    expect(rows.map((r) => `${r.role}:${r.nIde}`).sort()).toEqual([
      'AREA_DIRECTOR:22493452',
      'AREA_MANAGER:84069561',
    ]);
  });

  it('una cédula sin cuenta o sin activar se omite sin detener el resto del archivo', async () => {
    await person('99999999', 'pend@x.co', 'Sin activar');
    await db
      .update(accounts)
      .set({ status: 'PENDIENTE_VERIFICACION' })
      .where(sql`n_ide = '99999999'`);
    await db
      .insert(catalogEntries)
      .values([{ type: 'AREA', cEmp: 'GA', code: '10400', name: 'GESTION HUMANA' }]);
    const up = await upload(
      await xlsx([
        line({ JEFE: '5555555', DIRECTOR: '22493452' }), // 5555555 no existe
        line({
          CDGO_AREA: '10400',
          NMBRE_AREA: 'GESTION HUMANA',
          JEFE: '99999999',
          DIRECTOR: null,
        }),
      ]),
    ).expect(201);
    expect(up.body.status).toBe('LISTO');
    expect(up.body.stats).toMatchObject({ sinJefeAsignable: 2, directoresAsignables: 1 });
    await apply(up.body.id).expect(200);
    const rows = await roleRows();
    expect(rows.map((r) => `${r.role}:${r.nIde}`)).toEqual(['AREA_DIRECTOR:22493452']);
  });

  it('JEFE = DIRECTOR: prevalece el jefe y el área queda sin director', async () => {
    const up = await upload(await xlsx([line({ DIRECTOR: '84069561' })])).expect(201);
    expect(up.body.status).toBe('LISTO');
    const dump = JSON.stringify(up.body.stats.detalle);
    expect(dump).toContain('sin director asignado');
    await apply(up.body.id).expect(200);
    const rows = await roleRows();
    expect(rows.map((r) => `${r.role}:${r.nIde}`)).toEqual(['AREA_MANAGER:84069561']);
  });

  it('un área que no existe en el catálogo detiene la carga con el error', async () => {
    const up = await upload(await xlsx([line({ CDGO_AREA: '99999' })])).expect(201);
    expect(up.body.status).toBe('OBSERVADO');
    const errs = (
      await request(srv()).get(`/admin/imports/${up.body.id}/errors`).set('Cookie', hr.cookie)
    ).body.errors as { rule: string }[];
    expect(errs.some((e) => e.rule.includes('no existe en el catálogo'))).toBe(true);
  });

  it('exige columnas y rechaza un área repetida en el archivo', async () => {
    const noJefe = AREA_APPROVERS_COLUMNS.filter((c) => c !== 'JEFE');
    expect((await upload(await xlsx([line()], noJefe))).body.status).toBe('LISTO'); // JEFE es opcional
    const missing = AREA_APPROVERS_COLUMNS.filter((c) => c !== 'CDGO_AREA');
    expect((await upload(await xlsx([line()], missing))).body.status).toBe('OBSERVADO');
    const dup = await upload(await xlsx([line(), line({ DIRECTOR: null })])).expect(201);
    expect(dup.body.status).toBe('OBSERVADO');
  });

  it('el mismo archivo no se aplica dos veces; solo un administrador puede cargarlo', async () => {
    const buf = await xlsx([line()]);
    const up = await upload(buf).expect(201);
    await apply(up.body.id).expect(200);
    const again = await upload(buf);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DUPLICATE_FILE');
    const emp = await login('jefe@x.co');
    await upload(buf, emp).expect(403);
  });
});
