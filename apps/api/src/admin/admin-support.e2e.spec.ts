import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  auditLogs,
  companies,
  employeeSnapshots,
  importBatches,
  payrollConcepts,
  payrollDownloadAudit,
  payrollLines,
  payrollVersions,
  roleAssignments,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };
type Role = 'HR_ADMIN' | 'SYSTEM_ADMIN' | 'AREA_MANAGER';

describe.skipIf(!url)(
  'soporte administrativo: cuentas, roles, resumen, importaciones y volantes ajenos',
  () => {
    const ctx = createDb(url ?? '');
    const db = ctx.db;
    let app: INestApplication;
    const sent: { to: string; text: string }[] = [];
    const mailer: Mailer = {
      send: (to, _subject, text) => {
        sent.push({ to, text });
        return Promise.resolve();
      },
    };
    let hr: Sess & { id: string } = { cookie: '', csrf: '', id: '' };

    beforeAll(async () => {
      await runMigrations(url ?? '');
      const mod = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MAILER)
        .useValue(mailer)
        .compile();
      app = mod.createNestApplication();
      await app.init();
    });
    afterAll(async () => {
      await app.close();
      await ctx.pool.end();
    });

    const srv = () => app.getHttpServer();
    async function login(email: string, password = PASSWORD): Promise<Sess> {
      const res = await request(srv()).post('/auth/login').send({ email, password });
      return {
        cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
        csrf: res.body.csrfToken as string,
      };
    }
    async function person(
      nIde: string,
      email: string,
      over: {
        role?: Role;
        est?: 'V' | 'C';
        status?: 'ACTIVA' | 'PENDIENTE_VERIFICACION' | 'BLOQUEADA';
        mustChange?: boolean;
        snapshot?: boolean;
      } = {},
    ) {
      if (over.snapshot !== false)
        await db.insert(employeeSnapshots).values({
          nIde,
          nCont: '1',
          email,
          est: over.est ?? 'V',
          nombre: `NOMBRE ${nIde}`,
          cEmp: 'GA',
        });
      const [a] = await db
        .insert(accounts)
        .values({
          nIde,
          email,
          passwordHash: await hashPassword(PASSWORD),
          status: over.status ?? 'ACTIVA',
          mustChangePassword: over.mustChange ?? false,
        })
        .returning({ id: accounts.id });
      if (over.role)
        await db
          .insert(roleAssignments)
          .values({ accountId: a?.id ?? '', role: over.role, validFrom: '2020-01-01' });
      return a?.id ?? '';
    }

    beforeEach(async () => {
      sent.length = 0;
      await db.execute(
        sql`TRUNCATE audit_logs, payroll_download_audit, payroll_lines, payroll_versions, payroll_concepts, import_batch_rows, import_batches, verification_codes, sessions, role_assignments, accounts, employee_snapshots, companies CASCADE`,
      );
      const id = await person('ADM1', 'hr@x.co', { role: 'HR_ADMIN', snapshot: false });
      hr = { ...(await login('hr@x.co')), id };
    });

    const get = (path: string, s: Sess = hr) => request(srv()).get(path).set('Cookie', s.cookie);
    const post = (path: string, body: object = {}, s: Sess = hr) =>
      request(srv()).post(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);
    const put = (path: string, body: object = {}, s: Sess = hr) =>
      request(srv()).put(path).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf).send(body);

    describe('cuentas', () => {
      it('lista con búsqueda, estado, nombre, roles vigentes y paginación', async () => {
        await person('1001', 'ana@x.co', { role: 'AREA_MANAGER' });
        await person('1002', 'luis@x.co', { status: 'PENDIENTE_VERIFICACION' });
        await person('1003', 'bea@x.co', { status: 'BLOQUEADA' });
        const all = await get('/admin/accounts');
        expect(all.body.total).toBe(4);
        expect(all.headers['cache-control']).toContain('no-store');
        const ana = all.body.items.find((i: { email: string }) => i.email === 'ana@x.co');
        expect(ana).toMatchObject({
          nIde: '1001',
          name: 'NOMBRE 1001',
          status: 'ACTIVA',
          roles: ['AREA_MANAGER'],
        });
        expect(JSON.stringify(all.body)).not.toMatch(/passwordHash|password_hash|argon2/i);
        expect((await get('/admin/accounts?q=luis')).body.total).toBe(1);
        expect((await get('/admin/accounts?q=1003')).body.items[0].email).toBe('bea@x.co');
        expect((await get('/admin/accounts?status=BLOQUEADA')).body.total).toBe(1);
        expect((await get('/admin/accounts?pageSize=2&page=2')).body.items).toHaveLength(2);
        expect((await get('/admin/accounts?q=%25')).body.total).toBe(0);
        expect((await get('/admin/accounts?status=X')).status).toBe(400);
      });

      it('bloquea: cierra sesiones e impide ingresar; no permite bloquearse a sí mismo', async () => {
        const id = await person('1001', 'ana@x.co');
        const ana = await login('ana@x.co');
        expect((await get('/auth/me', ana)).status).toBe(200);
        expect((await post(`/admin/accounts/${id}/block`)).status).toBe(204);
        expect((await get('/auth/me', ana)).status).toBe(401);
        expect(
          (await request(srv()).post('/auth/login').send({ email: 'ana@x.co', password: PASSWORD }))
            .status,
        ).toBe(401);
        expect((await post(`/admin/accounts/${hr.id}/block`)).status).toBe(403);
        expect(
          (await post('/admin/accounts/00000000-0000-4000-8000-000000000000/block')).status,
        ).toBe(404);
      });

      it('un HR_ADMIN no puede bloquear a otro administrador; un SYSTEM_ADMIN sí', async () => {
        const other = await person('ADM2', 'hr2@x.co', { role: 'HR_ADMIN', snapshot: false });
        expect((await post(`/admin/accounts/${other}/block`)).status).toBe(403);
        await person('SYS1', 'sys@x.co', { role: 'SYSTEM_ADMIN', snapshot: false });
        const sys = { ...(await login('sys@x.co')) };
        expect((await post(`/admin/accounts/${other}/block`, {}, sys)).status).toBe(204);
      });

      it('desbloquea a ACTIVA o a PENDIENTE según el estado de su clave, y protege la unicidad', async () => {
        const a = await person('1001', 'ana@x.co', { status: 'BLOQUEADA' });
        const b = await person('1002', 'luis@x.co', { status: 'BLOQUEADA', mustChange: true });
        expect((await post(`/admin/accounts/${a}/unblock`)).body).toEqual({ status: 'ACTIVA' });
        expect((await post(`/admin/accounts/${b}/unblock`)).body).toEqual({
          status: 'PENDIENTE_VERIFICACION',
        });
        expect((await post(`/admin/accounts/${a}/unblock`)).status).toBe(409);
        const dup = await person('1003', 'dup@x.co', { status: 'BLOQUEADA' });
        await db.insert(accounts).values({
          nIde: '1003',
          email: 'dup@x.co',
          passwordHash: 'h',
          status: 'ACTIVA',
          mustChangePassword: false,
        });
        expect((await post(`/admin/accounts/${dup}/unblock`)).status).toBe(409);
      });

      it('restablece la clave: nueva temporal, cuenta pendiente, sesiones cerradas y código por correo', async () => {
        const id = await person('1001', 'ana@x.co');
        const ana = await login('ana@x.co');
        const res = await post(`/admin/accounts/${id}/reset-password`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toContain('no-store');
        expect(res.body.verificationSent).toBe(true);
        expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16,}$/);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.to).toBe('ana@x.co');
        expect(sent[0]?.text).not.toContain(res.body.temporaryPassword);
        expect((await get('/auth/me', ana)).status).toBe(401);
        expect(
          (await request(srv()).post('/auth/login').send({ email: 'ana@x.co', password: PASSWORD }))
            .status,
        ).toBe(401);
        const [row] = await db
          .select()
          .from(accounts)
          .where(sql`id = ${id}`);
        expect(row).toMatchObject({ status: 'PENDIENTE_VERIFICACION', mustChangePassword: true });

        const code = /es ([A-Z0-9]{8})\./.exec(sent[0]?.text ?? '')?.[1];
        const act = await request(srv()).post('/auth/activate').send({
          email: 'ana@x.co',
          temporaryPassword: res.body.temporaryPassword,
          code,
          newPassword: 'Una-Clave-Nueva-Larga-1',
        });
        expect(act.status).toBe(204);
        expect(
          (
            await request(srv())
              .post('/auth/login')
              .send({ email: 'ana@x.co', password: 'Una-Clave-Nueva-Larga-1' })
          ).status,
        ).toBe(200);
      });

      it('no restablece a sí mismo, ni cuentas bloqueadas, ni personas sin contrato vigente', async () => {
        expect((await post(`/admin/accounts/${hr.id}/reset-password`)).status).toBe(403);
        const blocked = await person('1001', 'ana@x.co', { status: 'BLOQUEADA' });
        expect((await post(`/admin/accounts/${blocked}/reset-password`)).status).toBe(409);
        const gone = await person('1002', 'luis@x.co', { est: 'C' });
        const res = await post(`/admin/accounts/${gone}/reset-password`);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('NO_ACTIVE_CONTRACT');
      });

      it('audita cada acción sin claves', async () => {
        const id = await person('1001', 'ana@x.co');
        await post(`/admin/accounts/${id}/block`);
        await post(`/admin/accounts/${id}/unblock`);
        const res = await post(`/admin/accounts/${id}/reset-password`);
        const rows = await db.select().from(auditLogs);
        const actions = rows.map((r) => r.action);
        expect(actions).toEqual(
          expect.arrayContaining(['ACCOUNT_BLOCK', 'ACCOUNT_UNBLOCK', 'ACCOUNT_PASSWORD_RESET']),
        );
        expect(JSON.stringify(rows)).not.toContain(res.body.temporaryPassword);
      });
    });

    describe('roles', () => {
      it('termina un rol vigente; solo un SYSTEM_ADMIN termina roles administrativos; nadie el propio', async () => {
        const id = await person('1001', 'ana@x.co', { role: 'AREA_MANAGER' });
        const [role] = await db
          .select()
          .from(roleAssignments)
          .where(sql`account_id = ${id}`);
        const today = new Date().toISOString().slice(0, 10);
        expect((await put(`/admin/accounts/${id}/roles/${role?.id}/end`, {})).status).toBe(204);
        expect(
          (
            await db
              .select()
              .from(roleAssignments)
              .where(sql`id = ${role?.id}`)
          )[0]?.validTo,
        ).toBe(today);
        expect(
          (await put(`/admin/accounts/${id}/roles/${role?.id}/end`, { validTo: '2999-01-01' }))
            .status,
        ).toBe(422);
        expect(
          (await put(`/admin/accounts/${id}/roles/00000000-0000-4000-8000-000000000000/end`, {}))
            .status,
        ).toBe(404);

        const other = await person('ADM2', 'hr2@x.co', { role: 'HR_ADMIN', snapshot: false });
        const [adminRole] = await db
          .select()
          .from(roleAssignments)
          .where(sql`account_id = ${other}`);
        expect((await put(`/admin/accounts/${other}/roles/${adminRole?.id}/end`, {})).status).toBe(
          403,
        );
        const [mine] = await db
          .select()
          .from(roleAssignments)
          .where(sql`account_id = ${hr.id}`);
        expect((await put(`/admin/accounts/${hr.id}/roles/${mine?.id}/end`, {})).status).toBe(403);
        await person('SYS1', 'sys@x.co', { role: 'SYSTEM_ADMIN', snapshot: false });
        const sys = await login('sys@x.co');
        expect(
          (await put(`/admin/accounts/${other}/roles/${adminRole?.id}/end`, {}, sys)).status,
        ).toBe(204);
      });
    });

    describe('resumen e historial de importaciones', () => {
      it('resume cuentas, empleados, importaciones pendientes, nómina publicada y catálogos', async () => {
        await person('1001', 'ana@x.co');
        await person('1002', 'luis@x.co', { est: 'C', status: 'PENDIENTE_VERIFICACION' });
        await db.insert(companies).values({ cEmp: 'GA', nombre: 'E', sigla: 'E', direccion: 'D' });
        await db.insert(payrollConcepts).values([
          { code: '1', name: 'A', unit: 'PES' },
          { code: '2', name: 'B', unit: 'HRS', active: false },
        ]);
        await db.insert(importBatches).values([
          {
            type: 'NOMINA',
            status: 'LISTO',
            fileHash: 'h1',
            sourceSystem: 's',
            responsible: 'r',
            createdBy: hr.id,
          },
          {
            type: 'EMPLEADOS',
            status: 'OBSERVADO',
            fileHash: 'h2',
            sourceSystem: 's',
            responsible: 'r',
            createdBy: hr.id,
          },
          {
            type: 'AREA',
            status: 'APLICADO',
            fileHash: 'h3',
            sourceSystem: 's',
            responsible: 'r',
            createdBy: hr.id,
          },
        ]);
        const res = await get('/admin/summary');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          accounts: { active: 2, pending: 1, blocked: 0 },
          employees: { active: 1, cancelled: 1 },
          pendingImports: { LISTO: 1, OBSERVADO: 1 },
          publishedPayrollVersions: 0,
          activeConcepts: 1,
          activeCompanies: 1,
        });
      });

      it('lista el historial de importaciones con filtros, autor y paginación', async () => {
        for (let i = 0; i < 4; i++) {
          await db.insert(importBatches).values({
            type: i % 2 ? 'NOMINA' : 'EMPLEADOS',
            status: i === 0 ? 'APLICADO' : 'OBSERVADO',
            fileHash: `h${i}`,
            fileName: `f${i}.xlsx`,
            sourceSystem: 's',
            responsible: 'r',
            createdBy: hr.id,
            rowCount: i,
          });
        }
        const all = await get('/admin/imports?pageSize=3');
        expect(all.body).toMatchObject({ total: 4, pageSize: 3 });
        expect(all.body.items).toHaveLength(3);
        expect(all.body.items[0].createdBy).toBe('hr@x.co');
        expect((await get('/admin/imports?type=NOMINA')).body.total).toBe(2);
        expect((await get('/admin/imports?status=APLICADO')).body.total).toBe(1);
        expect((await get('/admin/imports?pageSize=999')).status).toBe(400);
      });
    });

    describe('volantes de otras personas', () => {
      async function publishFor(nIde: string) {
        await db
          .insert(companies)
          .values({ cEmp: 'GA', nombre: 'Empresa', sigla: 'E', direccion: 'D' });
        const [b] = await db
          .insert(importBatches)
          .values({
            type: 'NOMINA',
            status: 'APLICADO',
            fileHash: 'hh',
            sourceSystem: 's',
            responsible: 'r',
            createdBy: hr.id,
            rowCount: 1,
          })
          .returning({ id: importBatches.id });
        const [v] = await db
          .insert(payrollVersions)
          .values({
            per: '202609',
            nLiq: 1,
            version: 1,
            status: 'PUBLICADA',
            contentHash: 'c'.repeat(64),
            batchId: b?.id ?? '',
            rowCount: 1,
            totalDev: '100',
            totalDed: '0',
          })
          .returning({ id: payrollVersions.id });
        await db.insert(payrollLines).values({
          versionId: v?.id ?? '',
          rowIndex: 0,
          nIde,
          contrato: '1',
          cCon: '100',
          concepto: 'Salario',
          slrio: '1000',
          dev: '100',
        });
      }
      const path = (mode = 'SIN_AJUSTE', reason = 'Solicitud de auditoría interna') =>
        `/admin/payroll/employees/1001/202609/1/1/pdf?mode=${mode}&reason=${encodeURIComponent(reason)}`;
      const pdf = (p: string, s: Sess = hr) =>
        request(srv())
          .get(p)
          .set('Cookie', s.cookie)
          .buffer(true)
          .parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on('data', (c: Buffer) => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
          });

      it('lista y descarga el volante ajeno con motivo, y deja evidencia completa', async () => {
        await person('1001', 'ana@x.co');
        await publishFor('1001');
        const list = await get('/admin/payroll/employees/1001/vouchers');
        expect(list.body).toEqual([{ per: '202609', nLiq: 1, contrato: '1' }]);
        const res = await pdf(path());
        expect(res.status).toBe(200);
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
        expect(res.headers['content-disposition']).toContain('attachment');
        const [audit] = await db.select().from(payrollDownloadAudit);
        expect(audit).toMatchObject({
          accountId: hr.id,
          targetNIde: '1001',
          reason: 'Solicitud de auditoría interna',
          result: 'SUCCESS',
          mode: 'SIN_AJUSTE',
        });
        const actions = (await db.select().from(auditLogs)).map((r) => r.action);
        expect(actions).toEqual(
          expect.arrayContaining(['ADMIN_PAYROLL_LIST', 'ADMIN_PAYROLL_ACCESS']),
        );
      });

      it('exige motivo suficiente, modo válido, reautenticación y una persona existente', async () => {
        await person('1001', 'ana@x.co');
        await publishFor('1001');
        expect((await pdf(path('SIN_AJUSTE', 'corto'))).status).toBe(400);
        expect(
          (await pdf('/admin/payroll/employees/1001/202609/1/1/pdf?mode=SIN_AJUSTE')).status,
        ).toBe(400);
        expect((await pdf(path('REDONDEO'))).status).toBe(400);
        expect(
          (
            await pdf(
              '/admin/payroll/employees/1001/202601/1/1/pdf?mode=SIN_AJUSTE&reason=Motivo%20suficiente%20ok',
            )
          ).status,
        ).toBe(404);
        expect((await get('/admin/payroll/employees/9999999/vouchers')).status).toBe(404);
        await db.execute(
          sql`UPDATE sessions SET created_at = now() - interval '11 minutes' WHERE account_id = ${hr.id}`,
        );
        expect((await pdf(path())).status).toBe(403);
      });

      it('un empleado no puede usar estas rutas para ver volantes ajenos', async () => {
        await person('1001', 'ana@x.co');
        await person('1002', 'luis@x.co');
        await publishFor('1001');
        const luis = await login('luis@x.co');
        expect((await pdf(path(), luis)).status).toBe(403);
        expect((await get('/admin/payroll/employees/1001/vouchers', luis)).status).toBe(403);
      });
    });
  },
);
