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
  employeeSnapshots,
  progVac,
  progVacAdjustments,
  roleAssignments,
} from '../db/schema';
import { PROG_VAC_COLUMNS } from './prog-vac.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Cell = string | number | null | { formula: string };

async function xlsx(rows: Cell[][], header: readonly string[] = PROG_VAC_COLUMNS): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja 1');
  ws.addRow([...header]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
// N_IDE, N_CONT, PER_INI, PER_FIN, DIAS, DISP, EST (como el archivo de muestra: números y fechas de texto)
const row = (o: Partial<Record<'i' | 'c' | 'a' | 'b' | 'd' | 'p' | 'e', Cell>> = {}): Cell[] => {
  const pick = (k: keyof typeof o, d: Cell): Cell => (k in o ? (o[k] ?? null) : d);
  return [
    pick('i', 100),
    pick('c', 1),
    pick('a', '01/01/2025'),
    pick('b', '31/12/2025'),
    pick('d', 15),
    pick('p', 10),
    pick('e', 'A'),
  ];
};

describe.skipIf(!url)('carga Excel de PROG_VAC (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let hr = { cookie: '', csrf: '' };
  const srv = () => app.getHttpServer();

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
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  async function person(nIde: string, email: string, role?: 'HR_ADMIN') {
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
  const upload = (buf: Buffer, extra: Record<string, string> = {}, s = hr) =>
    request(srv())
      .post('/admin/imports/prog-vac')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .field('sourceSystem', 'Sistema de nómina')
      .field('responsible', 'gh@x.co')
      .field('fechaCorte', extra.fechaCorte ?? '2026-09-01')
      .attach('file', buf, { filename: 'PROG_VAC.xlsx' });
  const apply = (id: string) =>
    request(srv())
      .post(`/admin/imports/${id}/apply`)
      .set('Cookie', hr.cookie)
      .set('X-CSRF-Token', hr.csrf);

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE prog_vac_adjustments, prog_vac, import_batch_rows, import_batches, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    hr = await person('ADM', 'hr@x.co', 'HR_ADMIN');
    await person('100', 'e@x.co');
  });

  it('valida, muestra la vista previa y aplica sin cambiar nada antes de confirmar', async () => {
    const up = await upload(
      await xlsx([row(), row({ a: '01/01/2024', b: '31/12/2024', p: 0 })]),
    ).expect(201);
    expect(up.body).toMatchObject({
      type: 'PROG_VAC',
      status: 'LISTO',
      rowCount: 2,
      errorCount: 0,
    });
    expect(up.body.stats).toMatchObject({ created: 2, changed: 0, fechaCorte: '2026-09-01' });
    expect(await db.select().from(progVac)).toHaveLength(0);
    await apply(up.body.id).expect(200);
    const rows = await db.select().from(progVac).orderBy(progVac.perIni);
    expect(
      rows.map((r) => [
        r.nIde,
        r.nCont,
        r.perIni,
        r.dias,
        r.disp,
        r.estado,
        r.fechaCorte,
        r.source,
      ]),
    ).toEqual([
      ['100', '1', '2024-01-01', 15, 0, 'LIQUIDADA', '2026-09-01', 'IMPORT'],
      ['100', '1', '2025-01-01', 15, 10, 'ACTIVA', '2026-09-01', 'IMPORT'],
    ]);
    await apply(up.body.id).expect(409);
  });

  it('una nueva carga corrige períodos existentes con ajuste versionado y es idempotente por archivo', async () => {
    const firstFile = await xlsx([row()]);
    const first = await upload(firstFile).expect(201);
    await apply(first.body.id).expect(200);
    const second = await upload(
      await xlsx([row({ p: 4 }), row({ a: '01/01/2026', b: '31/12/2026', p: 15 })]),
    ).expect(201);
    expect(second.body.stats).toMatchObject({ created: 1, changed: 1, unchanged: 0 });
    await apply(second.body.id).expect(200);
    const [p] = await db
      .select()
      .from(progVac)
      .where(sql`${progVac.perIni} = '2025-01-01'`);
    expect(p).toMatchObject({ disp: 4, version: 2 });
    const adj = await db.select().from(progVacAdjustments);
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ oldDisp: 10, newDisp: 4 });
    expect(adj[0]?.reason).toContain('fecha de corte 2026-09-01');
    await upload(firstFile).expect(409); // el mismo archivo ya aplicado
  });

  it('rechaza (OBSERVADO, sin aplicar) filas inválidas y advierte de identificadores numéricos', async () => {
    const bad = await upload(
      await xlsx([
        row({ p: 16 }), // DISP > DIAS
        row({ d: 16, p: 1, a: '02/01/2025' }), // DIAS > 15
        row({ a: '31/02/2025' }), // fecha inexistente
        row({ a: '05/01/2025', b: '01/01/2025' }), // fin < inicio
        row({ i: 999, a: '06/01/2025' }), // empleado inexistente
        row({ i: 1.5, a: '07/01/2025' }), // no entero
        row({ p: null, a: '08/01/2025' }), // obligatorio vacío
        row({ p: { formula: '1+1' } as unknown as Cell, a: '09/01/2025' }), // fórmula
      ]),
    ).expect(201);
    expect(bad.body.status).toBe('OBSERVADO');
    expect(bad.body.errorCount).toBe(8);
    await apply(bad.body.id).expect(409);
    expect(await db.select().from(progVac)).toHaveLength(0);

    const dup = await upload(await xlsx([row(), row({ p: 9 })])).expect(201);
    expect(dup.body.status).toBe('OBSERVADO'); // mismo período con datos distintos
    const same = await upload(await xlsx([row(), row()])).expect(201);
    expect(same.body).toMatchObject({ status: 'LISTO', rowCount: 1 });
  });

  it('exige columnas, fecha de corte válida, archivo xlsx y perfil administrador', async () => {
    await upload(await xlsx([row()], ['N_IDE', 'N_CONT', 'PER_INI', 'PER_FIN', 'DIAS', 'DISP']))
      .expect(201)
      .then((r) => {
        expect(r.body.status).toBe('OBSERVADO');
      });
    await upload(await xlsx([row()], [...PROG_VAC_COLUMNS, 'EXTRA']))
      .expect(201)
      .then((r) => {
        expect(r.body.status).toBe('OBSERVADO');
      });
    await upload(await xlsx([row()]), { fechaCorte: '2026-13-40' }).expect(400);
    await upload(Buffer.from('no es un excel')).expect(400);
    const e = await login('e@x.co');
    await upload(await xlsx([row()]), {}, e).expect(403);
  });
});
