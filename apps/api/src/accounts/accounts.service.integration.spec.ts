import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accounts, auditLogs, employeeSnapshots, roleAssignments } from '../db/schema';
import { AccountError, createAccountByAdmin } from './accounts.service';
import { verifyPassword } from './password.service';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('alta administrativa de cuentas', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let adminId = '';
  let plainId = '';

  beforeAll(async () => {
    await runMigrations(url ?? '');
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, role_assignments, accounts, employee_snapshots CASCADE`,
    );
    const [a] = await db
      .insert(accounts)
      .values({ nIde: 'ADM', email: 'admin@x.co', passwordHash: 'h', status: 'ACTIVA' })
      .returning({ id: accounts.id });
    const [p] = await db
      .insert(accounts)
      .values({ nIde: 'EMP0', email: 'emp0@x.co', passwordHash: 'h', status: 'ACTIVA' })
      .returning({ id: accounts.id });
    adminId = a?.id ?? '';
    plainId = p?.id ?? '';
    await db
      .insert(roleAssignments)
      .values({ accountId: adminId, role: 'HR_ADMIN', validFrom: '2020-01-01' });
  });

  const emp = (over: Partial<typeof employeeSnapshots.$inferInsert> = {}) =>
    db
      .insert(employeeSnapshots)
      .values({ nIde: '100', nCont: '1', email: ' Ana@X.co ', est: 'V', ...over });

  it('crea la cuenta pendiente con clave temporal Argon2id y correo normalizado', async () => {
    await emp();
    const r = await createAccountByAdmin(db, adminId, '100');
    const [acc] = await db
      .select()
      .from(accounts)
      .where(sql`id = ${r.accountId}`);
    expect(acc?.email).toBe('ana@x.co');
    expect(acc?.status).toBe('PENDIENTE_VERIFICACION');
    expect(acc?.mustChangePassword).toBe(true);
    expect(acc?.passwordHash).not.toContain(r.temporaryPassword);
    expect(await verifyPassword(acc?.passwordHash ?? '', r.temporaryPassword)).toBe(true);
  });

  it('rechaza a quien no tiene HR_ADMIN vigente', async () => {
    await emp();
    await expect(createAccountByAdmin(db, plainId, '100')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rechaza rol HR_ADMIN vencido', async () => {
    await emp();
    await db
      .update(roleAssignments)
      .set({ validTo: '2021-01-01' })
      .where(sql`account_id = ${adminId}`);
    await expect(createAccountByAdmin(db, adminId, '100')).rejects.toBeInstanceOf(AccountError);
  });

  it('rechaza empleado inexistente y contrato cancelado', async () => {
    await expect(createAccountByAdmin(db, adminId, '999')).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    });
    await emp({ nIde: '200', est: 'C' });
    await expect(createAccountByAdmin(db, adminId, '200')).rejects.toMatchObject({
      code: 'NO_ACTIVE_CONTRACT',
    });
  });

  it('rechaza correo vacío', async () => {
    await emp({ email: '  ' });
    await expect(createAccountByAdmin(db, adminId, '100')).rejects.toMatchObject({
      code: 'EMAIL_MISSING',
    });
  });

  it('rechaza una segunda cuenta para el mismo N_IDE', async () => {
    await emp();
    await createAccountByAdmin(db, adminId, '100');
    await expect(createAccountByAdmin(db, adminId, '100')).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
  });

  it('impide dos contratos vigentes para la misma persona', async () => {
    await emp();
    await expect(emp({ nCont: '2' })).rejects.toThrow();
  });

  it('audita éxito y rechazo sin claves ni identificación completa', async () => {
    await emp({ nIde: '1234567890' });
    const r = await createAccountByAdmin(db, adminId, '1234567890');
    await createAccountByAdmin(db, plainId, '1234567890').catch(() => undefined);
    const logs = await db.select().from(auditLogs);
    expect(logs.map((l) => l.result).sort()).toEqual(['FORBIDDEN', 'SUCCESS']);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(r.temporaryPassword);
    expect(dump).not.toContain('"100"');
  });
});
