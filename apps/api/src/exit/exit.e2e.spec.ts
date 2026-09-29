import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  auditLogs,
  documentExportDownloads,
  documentExports,
  employeeExitSchedules,
  employeeSnapshots,
  exitSettings,
  roleAssignments,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { EncryptedObjectStore } from '../storage/encrypted-object-store';
import { MemoryObjectStore } from '../storage/memory-object-store';
import { OBJECT_STORE } from '../storage/object-store';
import { ExitNoticeService } from './exit-notice.service';
import { ExportZipMonitor } from './export-zip.monitor';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string; id: string };

describe.skipIf(!url)('baja: aviso previo y exportación ZIP (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let notice: ExitNoticeService;
  let zipMonitor: ExportZipMonitor;
  const srv = () => app.getHttpServer();
  const sent: { to: string; subject: string }[] = [];
  const mailer: Mailer = {
    send: (to, subject) => {
      sent.push({ to, subject });
      return Promise.resolve();
    },
  };
  const raw = new MemoryObjectStore();
  const store = new EncryptedObjectStore(
    raw,
    'clave-de-objetos-de-prueba-con-mas-de-32-caracteres',
  );
  let adm: Sess;
  let emp: Sess;

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(OBJECT_STORE)
      .useValue(store)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    notice = app.get(ExitNoticeService);
    zipMonitor = app.get(ExportZipMonitor);
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  const send = (s: Sess, method: 'post' | 'get' | 'put', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };

  async function person(
    nIde: string,
    email: string,
    roles: { role: 'HR_ADMIN' }[] = [],
  ): Promise<Sess> {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email, est: 'V', nombre: `Persona ${nIde}`, cEmp: 'GA' });
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
    for (const r of roles)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role: r.role, validFrom: '2020-01-01' });
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
      id: a?.id ?? '',
    };
  }

  beforeEach(async () => {
    raw.objects.clear();
    sent.length = 0;
    await db.execute(
      sql`TRUNCATE document_export_downloads, document_exports, employee_exit_schedules, exit_settings, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    adm = await person('ADM', 'adm@x.co', [{ role: 'HR_ADMIN' }]);
    emp = await person('100', 'e@x.co');
  });

  it('programa una baja y rechaza una segunda mientras la primera siga activa', async () => {
    const r1 = await send(adm, 'post', '/admin/exit/schedule', {
      nIde: '100',
      plannedDate: '2026-12-01',
      reason: 'Fin de contrato acordado con el área.',
    }).expect(201);
    expect(r1.body.status).toBe('PENDIENTE');
    await send(adm, 'post', '/admin/exit/schedule', {
      nIde: '100',
      plannedDate: '2026-12-15',
      reason: 'Segundo intento sobre el mismo empleado.',
    }).expect(400);
  });

  it('el aviso se envía al llegar al umbral y crea una exportación pendiente', async () => {
    await send(adm, 'put', '/admin/exit/settings', {
      preBajaAvisoDias: 30,
      zipExpiryDays: 7,
    }).expect(200);
    await send(adm, 'post', '/admin/exit/schedule', {
      nIde: '100',
      plannedDate: '2026-10-01',
      reason: 'Baja programada dentro del plazo de aviso.',
    }).expect(201);

    const result = await notice.runOnce();
    expect(result.notified).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('e@x.co');

    const [schedule] = await db.select().from(employeeExitSchedules);
    expect(schedule?.status).toBe('AVISADO');
    expect(schedule?.noticeSentAt).not.toBeNull();
    const [exp] = await db.select().from(documentExports);
    expect(exp?.status).toBe('PENDIENTE');
    expect(exp?.requestKind).toBe('AUTO_AVISO');
  });

  it('arma el ZIP, permite descargarlo y lo bloquea tras la caducidad', async () => {
    await db.insert(exitSettings).values({ id: 1, preBajaAvisoDias: 30, zipExpiryDays: 7 });
    await send(adm, 'post', '/admin/exit/schedule', {
      nIde: '100',
      plannedDate: '2026-10-01',
      reason: 'Baja programada dentro del plazo de aviso.',
    }).expect(201);
    await notice.runOnce();
    await zipMonitor.runOnce();

    const [exp] = await db.select().from(documentExports);
    expect(exp?.status).toBe('LISTO');
    expect(exp?.objectKey).toMatch(/^exit-exports\//);
    expect(exp?.sha256).toBeTruthy();
    expect(exp?.manifest as unknown as { fileName: string }[]).toContainEqual(
      expect.objectContaining({ fileName: 'contratos.json' }),
    );

    const dl = await request(srv())
      .get(`/admin/exit/exports/${exp?.id ?? ''}/download`)
      .set('Cookie', adm.cookie)
      .buffer(true)
      .expect(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(Number(dl.headers['content-length'])).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(documentExportDownloads)
      .where(eq(documentExportDownloads.exportId, exp?.id ?? ''));
    expect(rows).toHaveLength(1);

    await db
      .update(documentExports)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(documentExports.id, exp?.id ?? ''));
    await send(adm, 'get', `/admin/exit/exports/${exp?.id ?? ''}/download`).expect(404);
  });

  it('EST=C con aviso ya enviado no genera incumplimiento; sin aviso sí, y revoca la sesión igual', async () => {
    await db.insert(exitSettings).values({ id: 1, preBajaAvisoDias: 30, zipExpiryDays: 7 });
    // Caso con aviso enviado
    await send(adm, 'post', '/admin/exit/schedule', {
      nIde: '100',
      plannedDate: '2026-10-01',
      reason: 'Baja programada dentro del plazo de aviso.',
    }).expect(201);
    await notice.runOnce();
    const [snap1] = await db
      .select()
      .from(employeeSnapshots)
      .where(eq(employeeSnapshots.nIde, '100'));
    await send(adm, 'post', `/admin/employees/${snap1?.id ?? ''}/status`, {
      est: 'C',
      version: snap1?.version ?? 1,
      reason: 'Baja aplicada tras el aviso.',
    }).expect(200);
    let noNotice = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'EXIT_NO_NOTICE_INCUMPLIMIENTO'));
    expect(noNotice).toHaveLength(0);
    const [sessRow] = await db.select().from(accounts).where(eq(accounts.nIde, '100'));
    expect(sessRow?.status).toBe('ACTIVA'); // la cuenta no se bloquea, solo se revocan sesiones

    // Caso sin aviso: otro empleado
    await db.insert(employeeSnapshots).values({
      nIde: '200',
      nCont: '1',
      email: 'f@x.co',
      est: 'V',
      nombre: 'Persona 200',
      cEmp: 'GA',
    });
    const [snap2] = await db
      .select()
      .from(employeeSnapshots)
      .where(eq(employeeSnapshots.nIde, '200'));
    await send(adm, 'post', `/admin/employees/${snap2?.id ?? ''}/status`, {
      est: 'C',
      version: snap2?.version ?? 1,
      reason: 'Baja sin aviso previo.',
    }).expect(200);
    noNotice = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'EXIT_NO_NOTICE_INCUMPLIMIENTO'));
    expect(noNotice).toHaveLength(1);
    expect(noNotice[0]?.context).toMatchObject({ nIde: '200' });
  });

  it('la exportación a pedido del admin exige motivo y queda auditada', async () => {
    await send(adm, 'post', '/admin/exit/exports', { nIde: '100', reason: 'corto' }).expect(400);
    const r = await send(adm, 'post', '/admin/exit/exports', {
      nIde: '100',
      reason: 'Solicitud administrativa con propósito declarado.',
    }).expect(201);
    expect(r.body.requestKind).toBe('ADMIN_ONDEMAND');
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'EXIT_EXPORT_REQUEST'));
    expect(row?.context).toMatchObject({ nIde: '100' });
  });

  it('el autoservicio de "mi baja" solo ve la exportación propia', async () => {
    await db.insert(exitSettings).values({ id: 1, preBajaAvisoDias: 30, zipExpiryDays: 7 });
    await send(adm, 'post', '/admin/exit/schedule', {
      nIde: '100',
      plannedDate: '2026-10-01',
      reason: 'Baja programada dentro del plazo de aviso.',
    }).expect(201);
    await notice.runOnce();
    await zipMonitor.runOnce();

    const st = await send(emp, 'get', '/me/exit/status').expect(200);
    expect(st.body.export.available).toBe(true);
    const dl = await request(srv())
      .get('/me/exit/export/download')
      .set('Cookie', emp.cookie)
      .buffer(true)
      .expect(200);
    expect(dl.headers['content-type']).toBe('application/zip');

    // otro empleado sin baja programada no tiene nada que descargar
    const other = await person('900', 'z2@x.co');
    const st2 = await send(other, 'get', '/me/exit/status').expect(200);
    expect(st2.body.export).toBeNull();
    await send(other, 'get', '/me/exit/export/download').expect(404);
  });
});
