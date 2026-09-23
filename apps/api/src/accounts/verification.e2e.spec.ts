import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  auditLogs,
  employeeSnapshots,
  roleAssignments,
  verificationCodes,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { createAccountByAdmin } from './accounts.service';
import { hashPassword } from './password.service';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('verificación por correo y activación (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  let adminId = '';
  const sent: { to: string; subject: string; text: string }[] = [];
  let failMail = false;
  const mailer: Mailer = {
    send: (to, subject, text) => {
      if (failMail) return Promise.reject(new Error('smtp caído'));
      sent.push({ to, subject, text });
      return Promise.resolve();
    },
  };
  const NEW = 'Clave-Nueva-Segura-9';

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

  beforeEach(async () => {
    sent.length = 0;
    failMail = false;
    await db.execute(
      sql`TRUNCATE audit_logs, verification_codes, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: 'ADM',
        email: 'admin@x.co',
        passwordHash: await hashPassword('x'),
        status: 'ACTIVA',
      })
      .returning({ id: accounts.id });
    adminId = a?.id ?? '';
    await db
      .insert(roleAssignments)
      .values({ accountId: adminId, role: 'HR_ADMIN', validFrom: '2020-01-01' });
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '1234567890', nCont: '1', email: 'ana@x.co', est: 'V' });
  });

  const codeFrom = () =>
    /código de verificación de NOMFLOW es ([A-Z0-9]{8})/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';
  const activate = (b: Record<string, string>) =>
    request(app.getHttpServer()).post('/auth/activate').send(b);
  const create = () => createAccountByAdmin(db, adminId, '1234567890', mailer);

  it('envía el código al correo de EMPLEADOS sin incluir la clave temporal', async () => {
    const r = await create();
    expect(r.verificationSent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ana@x.co');
    expect(sent[0]?.text).not.toContain(r.temporaryPassword);
  });

  it('guarda solo el hash del código', async () => {
    await create();
    const rows = await db.select().from(verificationCodes);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(codeFrom());
  });

  it('activa la cuenta y permite iniciar sesión con la clave nueva', async () => {
    const r = await create();
    const res = await activate({
      email: 'ana@x.co',
      temporaryPassword: r.temporaryPassword,
      code: ` ${codeFrom().toLowerCase()} `,
      newPassword: NEW,
    });
    expect(res.status).toBe(204);
    const [acc] = await db
      .select()
      .from(accounts)
      .where(sql`email = 'ana@x.co'`);
    expect(acc?.status).toBe('ACTIVA');
    expect(acc?.mustChangePassword).toBe(false);
    expect(acc?.emailVerifiedAt).not.toBeNull();
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@x.co', password: NEW });
    expect(login.status).toBe(200);
    const old = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ana@x.co', password: r.temporaryPassword });
    expect(old.status).toBe(401);
  });

  it('el código es de un solo uso', async () => {
    const r = await create();
    const body = {
      email: 'ana@x.co',
      temporaryPassword: r.temporaryPassword,
      code: codeFrom(),
      newPassword: NEW,
    };
    expect((await activate(body)).status).toBe(204);
    expect((await activate({ ...body, newPassword: 'Otra-Clave-Segura-1' })).status).toBe(400);
  });

  it('rechaza código incorrecto y lo invalida tras 5 intentos', async () => {
    const r = await create();
    const good = codeFrom();
    const base = { email: 'ana@x.co', temporaryPassword: r.temporaryPassword, newPassword: NEW };
    for (let i = 0; i < 5; i++)
      expect((await activate({ ...base, code: 'AAAAAAAA' })).status).toBe(400);
    expect((await activate({ ...base, code: good })).status).toBe(400);
    const [acc] = await db
      .select()
      .from(accounts)
      .where(sql`email = 'ana@x.co'`);
    expect(acc?.status).toBe('PENDIENTE_VERIFICACION');
  });

  it('rechaza un código vencido', async () => {
    const r = await create();
    await db.execute(sql`UPDATE verification_codes SET expires_at = now() - interval '1 minute'`);
    const res = await activate({
      email: 'ana@x.co',
      temporaryPassword: r.temporaryPassword,
      code: codeFrom(),
      newPassword: NEW,
    });
    expect(res.status).toBe(400);
  });

  it('rechaza clave temporal errónea, clave nueva débil o igual a la temporal', async () => {
    const r = await create();
    const code = codeFrom();
    expect(
      (await activate({ email: 'ana@x.co', temporaryPassword: 'mala', code, newPassword: NEW }))
        .status,
    ).toBe(400);
    expect(
      (
        await activate({
          email: 'ana@x.co',
          temporaryPassword: r.temporaryPassword,
          code,
          newPassword: 'corta',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await activate({
          email: 'ana@x.co',
          temporaryPassword: r.temporaryPassword,
          code,
          newPassword: r.temporaryPassword,
        })
      ).status,
    ).toBe(400);
    const [acc] = await db
      .select()
      .from(accounts)
      .where(sql`email = 'ana@x.co'`);
    expect(acc?.status).toBe('PENDIENTE_VERIFICACION');
  });

  it('un código de otra cuenta no activa esta', async () => {
    await db
      .insert(employeeSnapshots)
      .values({ nIde: '9876543210', nCont: '1', email: 'luis@x.co', est: 'V' });
    const a = await create();
    const codeAna = codeFrom();
    const l = await createAccountByAdmin(db, adminId, '9876543210', mailer);
    const res = await activate({
      email: 'luis@x.co',
      temporaryPassword: l.temporaryPassword,
      code: codeAna,
      newPassword: NEW,
    });
    expect(res.status).toBe(400);
    expect(a.accountId).not.toBe(l.accountId);
  });

  it('reenvío: invalida el código anterior, responde igual para correos desconocidos y limita a 3 por hora', async () => {
    const r = await create();
    const first = codeFrom();
    const srv = app.getHttpServer();
    expect(
      (await request(srv).post('/auth/verify-email/resend').send({ email: 'nadie@x.co' })).status,
    ).toBe(202);
    expect(
      (await request(srv).post('/auth/verify-email/resend').send({ email: 'ana@x.co' })).status,
    ).toBe(202);
    const second = codeFrom();
    expect(second).not.toBe(first);
    const base = { email: 'ana@x.co', temporaryPassword: r.temporaryPassword, newPassword: NEW };
    expect((await activate({ ...base, code: first })).status).toBe(400);
    for (let i = 0; i < 3; i++)
      await request(srv).post('/auth/verify-email/resend').send({ email: 'ana@x.co' });
    expect(sent).toHaveLength(3);
    const results = (await db.select().from(auditLogs)).map((l) => l.result);
    expect(results).toContain('RATE_LIMITED');
  });

  it('si el SMTP falla, la cuenta se crea, se informa y se audita sin filtrar el error', async () => {
    failMail = true;
    const r = await create();
    expect(r.verificationSent).toBe(false);
    const results = (await db.select().from(auditLogs)).map((l) => l.result);
    expect(results).toContain('MAIL_FAILED');
    failMail = false;
    await request(app.getHttpServer())
      .post('/auth/verify-email/resend')
      .send({ email: 'ana@x.co' });
    expect(sent).toHaveLength(1);
  });
});
