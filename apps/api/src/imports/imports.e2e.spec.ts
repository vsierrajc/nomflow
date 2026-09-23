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
import { accounts, employeeSnapshots, importBatches, roleAssignments } from '../db/schema';
import { EMPLOYEE_COLUMNS } from './employees.parser';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';

type Row = Partial<
  Record<(typeof EMPLOYEE_COLUMNS)[number], string | number | Date | { formula: string }>
>;

const base = (over: Row = {}): Row => ({
  C_EMP: '01',
  N_IDE: '1000000001',
  NOMBRE: 'ANA PRUEBA',
  C_COS: 'CC1',
  CCOSTO: 'Costo Uno',
  S_ACT: 1500000.5,
  N_CONT: '1',
  C_CAR: 'CA1',
  C_AREA: 'A1',
  FEC_NAC: new Date(Date.UTC(1990, 4, 17)),
  CARGO: 'Analista',
  AREA: 'Area Uno',
  HLIQ: 240,
  SEXO: 'F',
  F_INI: new Date(Date.UTC(2020, 0, 6)),
  TURNO: 'D',
  EST: 'V',
  EMAIL: 'Ana@Prueba.co',
  NOMBRES: 'ANA',
  APELLIDOS: 'PRUEBA',
  CELULAR: '3000000000',
  PROFESION: 'X',
  NIVELEDUCATIVO: 'Y',
  TIPO_CONTRATO: '01',
  ...over,
});

async function xlsx(rows: Row[], columns: readonly string[] = EMPLOYEE_COLUMNS): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow([...columns]);
  for (const r of rows) ws.addRow(columns.map((c) => r[c as keyof Row] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!url)('importación de EMPLEADOS (HTTP + PostgreSQL)', () => {
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

  async function login(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, import_batch_rows, import_batches, verification_codes, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
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
    ({ cookie, csrf } = await login('hr@x.co'));
  });

  const upload = (buf: Buffer, fields: Record<string, string> = {}, auth = { cookie, csrf }) => {
    const r = request(app.getHttpServer())
      .post('/admin/imports/employees')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .field('sourceSystem', fields.sourceSystem ?? 'ERP')
      .field('responsible', fields.responsible ?? 'Gestión Humana');
    if (fields.sheet) r.field('sheet', fields.sheet);
    return r.attach('file', buf, { filename: 'EMPLEADOS.xlsx' });
  };
  const apply = (id: string) =>
    request(app.getHttpServer())
      .post(`/admin/imports/${id}/apply`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf);
  const errorsOf = (id: string) =>
    request(app.getHttpServer()).get(`/admin/imports/${id}/errors`).set('Cookie', cookie);

  it('valida, deja el lote LISTO y no publica hasta aplicar', async () => {
    const res = await upload(
      await xlsx([
        base(),
        base({ N_IDE: '1000000002', EMAIL: 'luis@prueba.co', TIPO_CONTRATO: '02' }),
      ]),
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('LISTO');
    expect(res.body.rowCount).toBe(2);
    expect(res.body.stats).toMatchObject({ people: 2, active: 2, created: 2, changed: 0 });
    expect(await db.select().from(employeeSnapshots)).toHaveLength(0);
  });

  it('al aplicar persiste con ceros iniciales, fechas, decimales exactos y correo normalizado', async () => {
    const up = await upload(await xlsx([base()]));
    const res = await apply(up.body.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APLICADO');
    const [row] = await db.select().from(employeeSnapshots);
    expect(row).toMatchObject({
      nIde: '1000000001',
      tipoContrato: '01',
      email: 'ana@prueba.co',
      est: 'V',
      fecNac: '1990-05-17',
      fIni: '2020-01-06',
      sAct: '1500000.500000',
      hliq: '240',
    });
  });

  it('rechaza EST = A y no altera los datos publicados', async () => {
    const up = await upload(await xlsx([base({ EST: 'A' })]));
    expect(up.body.status).toBe('OBSERVADO');
    expect((await apply(up.body.id)).status).toBe(409);
    expect(await db.select().from(employeeSnapshots)).toHaveLength(0);
    const err = await errorsOf(up.body.id);
    expect(err.body.errors[0]).toMatchObject({ row: 2, column: 'EST', value: 'A' });
  });

  it('el reporte de errores no expone datos sensibles', async () => {
    const up = await upload(
      await xlsx([base({ EMAIL: 'no-es-correo', S_ACT: 'abc', N_IDE: '99', FEC_NAC: 'ayer' })]),
    );
    const dump = JSON.stringify((await errorsOf(up.body.id)).body);
    for (const secret of ['no-es-correo', 'abc', 'ayer']) expect(dump).not.toContain(secret);
    expect(up.body.errorCount).toBeGreaterThanOrEqual(3);
  });

  it('rechaza encabezados incorrectos: faltante, duplicado y desconocido', async () => {
    const missing = EMPLOYEE_COLUMNS.filter((c) => c !== 'EMAIL');
    const r1 = await upload(await xlsx([base()], missing));
    expect((await errorsOf(r1.body.id)).body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'EMAIL', rule: 'columna obligatoria ausente' }),
      ]),
    );
    const r2 = await upload(await xlsx([base()], [...EMPLOYEE_COLUMNS, 'EST']));
    expect((await errorsOf(r2.body.id)).body.errors[0].rule).toBe('columna duplicada');
    const r3 = await upload(await xlsx([base()], [...EMPLOYEE_COLUMNS, 'EXTRA']));
    expect((await errorsOf(r3.body.id)).body.errors[0].rule).toBe('columna no reconocida');
  });

  it('rechaza fórmulas en las celdas', async () => {
    const up = await upload(await xlsx([base({ NOMBRE: { formula: '1+1' } })]));
    expect(up.body.status).toBe('OBSERVADO');
    expect((await errorsOf(up.body.id)).body.errors[0].rule).toBe('fórmula no permitida');
  });

  it('detecta duplicados, correo compartido, dos contratos vigentes y correos distintos por persona', async () => {
    const rows = [
      base(),
      base(),
      base({ N_CONT: '2' }),
      base({ N_IDE: '1000000002', EMAIL: 'otro@prueba.co', N_CONT: '1' }),
      base({ N_IDE: '1000000003', EMAIL: 'ana@prueba.co' }),
      base({ N_IDE: '1000000002', N_CONT: '2', EMAIL: 'distinto@prueba.co', EST: 'C' }),
    ];
    const up = await upload(await xlsx(rows));
    const rules = (await errorsOf(up.body.id)).body.errors.map((e: { rule: string }) => e.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'contrato duplicado para la misma persona',
        'más de un contrato vigente para la misma persona',
        'correo compartido por personas distintas',
        'la misma persona tiene correos distintos',
      ]),
    );
  });

  it('acepta N_IDE numérico entero con advertencia y rechaza fracciones', async () => {
    const ok = await upload(await xlsx([base({ N_IDE: 1000000009, EMAIL: 'n@prueba.co' })]));
    expect(ok.body.status).toBe('LISTO');
    expect(ok.body.stats.warnings).toBeGreaterThan(0);
    const bad = await upload(await xlsx([base({ N_CONT: 1.5 })]));
    expect(bad.body.status).toBe('OBSERVADO');
  });

  it('rechaza un archivo que no es xlsx y exige los campos del lote', async () => {
    expect((await upload(Buffer.from('esto no es un excel'))).status).toBe(400);
    expect((await upload(Buffer.from('PK\u0003\u0004basura'))).status).toBe(400);
    const res = await request(app.getHttpServer())
      .post('/admin/imports/employees')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .attach('file', await xlsx([base()]), { filename: 'a.xlsx' });
    expect(res.status).toBe(400);
  });

  it('el mismo archivo ya aplicado no genera un segundo lote', async () => {
    const buf = await xlsx([base()]);
    const up = await upload(buf);
    await apply(up.body.id);
    const again = await upload(buf);
    expect(again.status).toBe(409);
    expect(await db.select().from(importBatches)).toHaveLength(1);
    expect((await apply(up.body.id)).status).toBe(409);
  });

  it('EST = C revoca sesiones y bloquea el acceso; las ausencias del archivo no dan de baja', async () => {
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1000000001', nCont: '1', email: 'ana@prueba.co', est: 'V' });
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '7777', nCont: '1', email: 'ausente@prueba.co', est: 'V' });
    await db.insert(accounts).values({
      nIde: '1000000001',
      email: 'ana@prueba.co',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVA',
      mustChangePassword: false,
    });
    const emp = await login('ana@prueba.co');
    expect(
      (await request(app.getHttpServer()).get('/auth/me').set('Cookie', emp.cookie)).status,
    ).toBe(200);

    const up = await upload(await xlsx([base({ EST: 'C' })]));
    expect(up.body.stats).toMatchObject({ toCancel: 1, missingInFile: 1 });
    expect((await apply(up.body.id)).status).toBe(200);
    expect(
      (await request(app.getHttpServer()).get('/auth/me').set('Cookie', emp.cookie)).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'ana@prueba.co', password: PASSWORD })
      ).status,
    ).toBe(401);
    const absent = await db
      .select()
      .from(employeeSnapshots)
      .where(sql`n_ide = '7777'`);
    expect(absent[0]?.est).toBe('V');
  });

  it('una persona puede cambiar de contrato: el anterior C y el nuevo V en el mismo archivo', async () => {
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1000000001', nCont: '1', email: 'ana@prueba.co', est: 'V' });
    const up = await upload(await xlsx([base({ N_CONT: '2' }), base({ N_CONT: '1', EST: 'C' })]));
    expect(up.body.status).toBe('LISTO');
    expect((await apply(up.body.id)).status).toBe(200);
    const rows = await db.select().from(employeeSnapshots).orderBy(employeeSnapshots.nCont);
    expect(rows.map((r) => `${r.nCont}${r.est}`)).toEqual(['1C', '2V']);
  });

  it('rechaza un contrato vigente nuevo si la base tiene otro vigente que el archivo no cancela', async () => {
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1000000001', nCont: '1', email: 'ana@prueba.co', est: 'V' });
    const up = await upload(await xlsx([base({ N_CONT: '2' })]));
    expect(up.body.status).toBe('OBSERVADO');
  });

  it('rechaza un correo que ya pertenece a otra persona en la base', async () => {
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '5555', nCont: '1', email: 'ana@prueba.co', est: 'V' });
    const up = await upload(await xlsx([base()]));
    expect(up.body.status).toBe('OBSERVADO');
  });

  it('aplicar dos veces en paralelo solo deja un resultado y el conteo cuadra', async () => {
    const up = await upload(
      await xlsx([base(), base({ N_IDE: '1000000002', EMAIL: 'luis@prueba.co' })]),
    );
    const [a, b] = await Promise.all([apply(up.body.id), apply(up.body.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.select().from(employeeSnapshots)).toHaveLength(2);
  });

  it('exige rol, sesión, CSRF y reautenticación reciente', async () => {
    const buf = await xlsx([base()]);
    expect(
      (
        await request(app.getHttpServer())
          .post('/admin/imports/employees')
          .attach('file', buf, { filename: 'a.xlsx' })
      ).status,
    ).toBe(401);
    await db
      .insert(employeeSnapshots)
      .values({ nIde: 'E2', nCont: '1', email: 'e2@x.co', est: 'V' });
    await db.insert(accounts).values({
      nIde: 'E2',
      email: 'e2@x.co',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVA',
      mustChangePassword: false,
    });
    expect((await upload(buf, {}, await login('e2@x.co'))).status).toBe(403);
    expect((await upload(buf, {}, { cookie, csrf: 'x'.repeat(64) })).status).toBe(403);
    await db.execute(sql`UPDATE sessions SET created_at = now() - interval '11 minutes'`);
    expect((await upload(buf)).status).toBe(403);
  });

  it('elige la hoja indicada y falla si no existe', async () => {
    expect((await upload(await xlsx([base()]), { sheet: 'Inexistente' })).body.status).toBe(
      'OBSERVADO',
    );
    expect((await upload(await xlsx([base()]), { sheet: 'Sheet1' })).body.status).toBe('LISTO');
  });
});
