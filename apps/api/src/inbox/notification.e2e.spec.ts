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
  employeeSnapshots,
  notificationLog,
  notificationSettings,
  permitRequests,
  permitTypes,
  roleAssignments,
  vacationRequests,
  vacationRevisions,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { NotificationService, validNotificationSettings } from './notification.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const DAY = 86_400_000;
type Sess = { cookie: string; csrf: string };

describe('validación de los ajustes de avisos', () => {
  const ok = { notifyApprover: true, notifyEmployee: true, reminderDays: 3, appUrl: '' };
  it('acepta lo válido y rechaza lo demás', () => {
    expect(validNotificationSettings(ok)).toBe(true);
    expect(
      validNotificationSettings({ ...ok, reminderDays: 0, appUrl: 'https://nomflow.gr4l.co' }),
    ).toBe(true);
    expect(validNotificationSettings({ ...ok, reminderDays: -1 })).toBe(false);
    expect(validNotificationSettings({ ...ok, reminderDays: 31 })).toBe(false);
    expect(validNotificationSettings({ ...ok, appUrl: 'javascript:alert(1)' })).toBe(false);
    expect(validNotificationSettings({ ...ok, appUrl: 'no es url' })).toBe(false);
  });
});

describe.skipIf(!url)('avisos por correo del flujo (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let svc: NotificationService;
  const srv = () => app.getHttpServer();
  const ids: Record<string, string> = {};
  const sess: Record<string, Sess> = {};
  const sent: { to: string; subject: string; text: string }[] = [];
  let failMail = false;
  const mailer: Mailer = {
    send: (to, subject, text) => {
      if (failMail) return Promise.reject(new Error('smtp caído'));
      sent.push({ to, subject, text });
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    svc = app.get(NotificationService);
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  async function person(
    key: string,
    o: {
      role?: 'VACATION_FINAL_APPROVER' | 'HR_ADMIN';
      status?: 'ACTIVA' | 'PENDIENTE_VERIFICACION';
    } = {},
  ) {
    const email = `${key.toLowerCase()}@x.co`;
    await db
      .insert(employeeSnapshots)
      .values({ nIde: key, nCont: '1', email, est: 'V', nombre: `PERSONA ${key}`, cEmp: 'GA' });
    const status = o.status ?? 'ACTIVA';
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: key,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status,
        mustChangePassword: status !== 'ACTIVA',
        emailVerifiedAt: status === 'ACTIVA' ? new Date() : null,
      })
      .returning({ id: accounts.id });
    ids[key] = a?.id ?? '';
    if (o.role)
      await db.insert(roleAssignments).values({
        accountId: ids[key] ?? '',
        role: o.role,
        companyCode: o.role === 'HR_ADMIN' ? null : 'GA',
        validFrom: '2020-01-01',
      });
    if (status === 'ACTIVA') {
      const res = await request(srv())
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      sess[key] = {
        cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
        csrf: res.body.csrfToken as string,
      };
    }
  }
  const call = (k: string, method: 'get' | 'put', path: string, body?: object) => {
    const agent = request(srv());
    const r = agent[method](path).set('Cookie', sess[k]?.cookie ?? '');
    return method === 'get' ? r : r.set('X-CSRF-Token', sess[k]?.csrf ?? '').send(body ?? {});
  };
  async function vacation(status: string, manager = 'JEF') {
    const [r] = await db
      .insert(vacationRequests)
      .values({
        accountId: ids.EMP ?? '',
        nIde: 'EMP',
        nCont: '1',
        cEmp: 'GA',
        cArea: 'A1',
        managerAccountId: ids[manager] ?? '',
        status,
      })
      .returning({ id: vacationRequests.id });
    await db.insert(vacationRevisions).values({
      requestId: r?.id ?? '',
      number: 1,
      startDate: '2026-11-02',
      endDate: '2026-11-13',
      calendarDiff: 12,
      businessDays: 10,
      returnDate: '2026-11-16',
      countedDays: [],
      calendarIds: [],
      proposedBy: ids.EMP ?? '',
      contentHash: 'h',
    });
    return r?.id ?? '';
  }
  const to = () => sent.map((m) => m.to).sort();

  beforeEach(async () => {
    sent.length = 0;
    failMail = false;
    await db.execute(
      sql`TRUNCATE notification_log, notification_settings, vacation_revisions, vacation_requests, permit_requests, permit_types, sessions, role_assignments, accounts, employee_snapshots, audit_logs CASCADE`,
    );
    await person('EMP');
    await person('JEF');
    await person('FIN1', { role: 'VACATION_FINAL_APPROVER' });
    await person('FIN2', { role: 'VACATION_FINAL_APPROVER' });
    await person('ADM', { role: 'HR_ADMIN' });
  });

  it('avisa al jefe una sola vez y de nuevo solo cuando cambia el paso', async () => {
    const id = await vacation('PENDIENTE_JEFE');
    expect(await svc.sweep()).toEqual({ sent: 1, failed: 0 });
    expect(to()).toEqual(['jef@x.co']);
    expect(sent[0]?.subject).toContain('actividades pendientes');
    expect(sent[0]?.text).toContain('PERSONA EMP');
    expect(sent[0]?.text).toContain('2026-11-02 a 2026-11-13');
    await svc.sweep();
    expect(sent).toHaveLength(1);

    // el jefe aprueba: ahora es de los dos aprobadores finales (y el jefe ya no recibe nada)
    await db
      .update(vacationRequests)
      .set({ status: 'PENDIENTE_FINAL' })
      .where(eq(vacationRequests.id, id));
    await svc.sweep();
    expect(to()).toEqual(['fin1@x.co', 'fin2@x.co', 'jef@x.co']);
    await svc.sweep();
    expect(sent).toHaveLength(3);
  });

  it('el empleado recibe el cambio propuesto y la respuesta final', async () => {
    const id = await vacation('REVISION_EMPLEADO');
    await svc.sweep();
    expect(to()).toEqual(['emp@x.co']);
    expect(sent[0]?.text).toContain('el jefe propuso un cambio');
    sent.length = 0;
    await db
      .update(vacationRequests)
      .set({ status: 'APROBADA' })
      .where(eq(vacationRequests.id, id));
    await svc.sweep();
    expect(to()).toEqual(['emp@x.co']);
    expect(sent[0]?.subject).toContain('Respuesta');
    expect(sent[0]?.text).toContain('fue aprobada');
  });

  it('permisos: aviso al jefe y respuesta al empleado', async () => {
    const [pt] = await db
      .insert(permitTypes)
      .values({ code: 'REM', name: 'REMUNERADOS' })
      .returning({ id: permitTypes.id });
    const [p] = await db
      .insert(permitRequests)
      .values({
        accountId: ids.EMP ?? '',
        nIde: 'EMP',
        nCont: '1',
        cEmp: 'GA',
        cArea: 'A1',
        managerAccountId: ids.JEF ?? '',
        typeId: pt?.id ?? '',
        typeName: 'REMUNERADOS',
        startDate: '2026-11-03',
        endDate: '2026-11-03',
        justification: 'x',
        contentHash: 'h',
      })
      .returning({ id: permitRequests.id });
    await svc.sweep();
    expect(to()).toEqual(['jef@x.co']);
    expect(sent[0]?.text).toContain('REMUNERADOS');
    sent.length = 0;
    await db
      .update(permitRequests)
      .set({ status: 'RECHAZADO' })
      .where(eq(permitRequests.id, p?.id ?? ''));
    await svc.sweep();
    expect(to()).toEqual(['emp@x.co']);
    expect(sent[0]?.text).toContain('fue rechazada');
  });

  it('recordatorio a los 3 días, repetido cada 3 y sin recordar lo que ya se atendió', async () => {
    const id = await vacation('PENDIENTE_JEFE');
    await svc.sweep();
    sent.length = 0;
    await db.update(notificationLog).set({ sentAt: new Date(Date.now() - 2 * DAY) });
    await svc.sweep();
    expect(sent).toHaveLength(0); // aún no llegan a 3 días
    await db.update(notificationLog).set({ sentAt: new Date(Date.now() - 4 * DAY) });
    await svc.sweep();
    expect(to()).toEqual(['jef@x.co']);
    expect(sent[0]?.subject).toContain('Recordatorio');
    await svc.sweep();
    expect(sent).toHaveLength(1); // el recordatorio queda registrado: no se repite de inmediato
    // pasan otros 3 días: vuelve a recordar
    await db.update(notificationLog).set({ sentAt: new Date(Date.now() - 4 * DAY) });
    await svc.sweep();
    expect(sent).toHaveLength(2);
    // ya decidida: no hay más recordatorios
    await db
      .update(vacationRequests)
      .set({ status: 'RECHAZADA' })
      .where(eq(vacationRequests.id, id));
    await db.update(notificationLog).set({ sentAt: new Date(Date.now() - 9 * DAY) });
    sent.length = 0;
    await svc.sweep();
    expect(sent.map((m) => m.to)).toEqual(['emp@x.co']); // solo la respuesta al empleado
  });

  it('respeta los interruptores y los días del recordatorio', async () => {
    await db
      .insert(notificationSettings)
      .values({ id: 1, notifyApprover: false, notifyEmployee: true, reminderDays: 0 });
    await vacation('PENDIENTE_JEFE');
    await svc.sweep();
    expect(sent).toHaveLength(0); // avisos a aprobadores desactivados
    await vacation('REVISION_EMPLEADO');
    await svc.sweep();
    expect(to()).toEqual(['emp@x.co']);
    await db.update(notificationSettings).set({ notifyApprover: true });
    await svc.sweep();
    expect(to()).toEqual(['emp@x.co', 'jef@x.co']);
    // sin recordatorios: por viejo que sea el aviso no se repite
    await db.update(notificationLog).set({ sentAt: new Date(Date.now() - 30 * DAY) });
    sent.length = 0;
    await svc.sweep();
    expect(sent).toHaveLength(0);
  });

  it('no escribe a cuentas sin activar y les avisa cuando se activan', async () => {
    await person('JEF2', { status: 'PENDIENTE_VERIFICACION' });
    await vacation('PENDIENTE_JEFE', 'JEF2');
    await svc.sweep();
    expect(sent).toHaveLength(0);
    await db
      .update(accounts)
      .set({ status: 'ACTIVA' })
      .where(eq(accounts.id, ids.JEF2 ?? ''));
    await svc.sweep();
    expect(to()).toEqual(['jef2@x.co']);
  });

  it('un fallo de correo no rompe el barrido ni se da por enviado', async () => {
    await vacation('PENDIENTE_JEFE');
    failMail = true;
    expect(await svc.sweep()).toEqual({ sent: 0, failed: 1 });
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it('ajustes: solo administradores, validados, auditados y visibles con el historial', async () => {
    await call('EMP', 'get', '/admin/notifications').expect(403);
    await call('EMP', 'put', '/admin/notifications/settings', {}).expect(403);
    const base = (await call('ADM', 'get', '/admin/notifications').expect(200)).body;
    expect(base.settings).toEqual({
      notifyApprover: true,
      notifyEmployee: true,
      reminderDays: 3,
      appUrl: '',
    });
    for (const bad of [
      { ...base.settings, reminderDays: 99 },
      { ...base.settings, appUrl: 'ftp://x' },
      { reminderDays: 'x' },
    ])
      await call('ADM', 'put', '/admin/notifications/settings', bad).expect(400);
    const saved = await call('ADM', 'put', '/admin/notifications/settings', {
      notifyApprover: true,
      notifyEmployee: false,
      reminderDays: 5,
      appUrl: 'https://nomflow.gr4l.co/',
    }).expect(200);
    expect(saved.body).toEqual({
      notifyApprover: true,
      notifyEmployee: false,
      reminderDays: 5,
      appUrl: 'https://nomflow.gr4l.co',
    });
    const [a] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'NOTIFICATION_SETTINGS_UPDATE'));
    expect(a?.result).toBe('SUCCESS');
    await vacation('PENDIENTE_JEFE');
    await svc.sweep();
    expect(sent[0]?.text).toContain('https://nomflow.gr4l.co/bandeja');
    const after = (await call('ADM', 'get', '/admin/notifications').expect(200)).body;
    expect(after.recent).toHaveLength(1);
    expect(after.recent[0]).toMatchObject({ kind: 'NUEVA', recipient: 'jef@x.co' });
  });
});
