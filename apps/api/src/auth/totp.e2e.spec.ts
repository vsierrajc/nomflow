import { eq, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import { accountRecoveryCodes, accounts, accountTotp, auditLogs } from '../db/schema';
import { open } from '../security/secret-box';
import {
  clearTotpByAdmin,
  confirmTotpEnroll,
  disableTotp,
  getTotpState,
  regenerateRecoveryCodes,
  startTotpEnroll,
  TotpError,
  verifyTotp,
} from './totp.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';

describe.skipIf(!url)('segundo paso TOTP (servicio + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let id = '';

  beforeAll(async () => {
    await runMigrations(url ?? '');
  });
  afterAll(async () => {
    await ctx.pool.end();
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE audit_logs, sessions, accounts CASCADE`);
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: '100',
        email: 'ana@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    id = a?.id ?? '';
  });

  /** Lo que haría la app del teléfono: calcula el código a partir del secreto guardado. */
  async function appCode(offsetSteps = 0) {
    const [row] = await db.select().from(accountTotp).where(eq(accountTotp.accountId, id));
    const t = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: open(row?.secretSealed ?? ''),
    });
    return t.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
  }
  async function enroll() {
    await startTotpEnroll(db, id);
    return confirmTotpEnroll(db, id, await appCode());
  }
  const rejects = (p: Promise<unknown>, code: string) =>
    expect(p).rejects.toMatchObject({ code }) as Promise<void>;

  it('el inicio entrega un QR PNG y la clave manual; el secreto queda cifrado', async () => {
    const r = await startTotpEnroll(db, id);
    expect(r.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const [row] = await db.select().from(accountTotp);
    expect(row?.confirmedAt).toBeNull();
    expect(r.manualKey.replace(/ /g, '')).toBe(open(row?.secretSealed ?? ''));
    expect(row?.secretSealed).not.toContain(r.manualKey.replace(/ /g, ''));
    expect((await getTotpState(db, id)).active).toBe(false);
  });

  it('confirmar con código erróneo no activa; con el correcto activa y da 10 códigos de respaldo', async () => {
    await startTotpEnroll(db, id);
    await rejects(confirmTotpEnroll(db, id, '000000'), 'INVALID_CODE');
    const { recoveryCodes } = await confirmTotpEnroll(db, id, await appCode());
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    const [a] = await db.select().from(accounts);
    expect(a).toMatchObject({ twoFactorEnabled: true, twoFactorMethod: 'TOTP' });
    expect(await getTotpState(db, id)).toEqual({ active: true, recoveryCodesLeft: 10 });
    await rejects(startTotpEnroll(db, id), 'ALREADY_ENABLED');
  });

  it('un código TOTP no se acepta dos veces, y se tolera ±1 paso pero no más', async () => {
    await enroll();
    // El código del paso actual ya se usó al confirmar la activación.
    await rejects(verifyTotp(db, id, await appCode()), 'INVALID_CODE');
    expect(await verifyTotp(db, id, await appCode(1))).toBe('TOTP');
    await rejects(verifyTotp(db, id, await appCode(1)), 'INVALID_CODE');
    await rejects(verifyTotp(db, id, await appCode(-3)), 'INVALID_CODE');
    await rejects(verifyTotp(db, id, '12345'), 'INVALID_CODE');
    await rejects(verifyTotp(db, id, 'abcdef'), 'INVALID_CODE');
  });

  it('un código de respaldo sirve una sola vez y acepta guion y minúsculas', async () => {
    const { recoveryCodes } = await enroll();
    const c = recoveryCodes[0] ?? '';
    expect(await verifyTotp(db, id, c.toLowerCase().replace('-', ' '))).toBe('RECOVERY');
    await rejects(verifyTotp(db, id, c), 'INVALID_CODE');
    expect((await getTotpState(db, id)).recoveryCodesLeft).toBe(9);
  });

  it('regenerar y desactivar exigen clave y código vigente', async () => {
    const { recoveryCodes } = await enroll();
    await rejects(
      regenerateRecoveryCodes(db, id, 'mala', recoveryCodes[0] ?? ''),
      'INVALID_CREDENTIALS',
    );
    const again = await regenerateRecoveryCodes(db, id, PASSWORD, recoveryCodes[1] ?? '');
    expect(again.recoveryCodes).toHaveLength(10);
    // Los códigos anteriores dejaron de servir.
    await rejects(verifyTotp(db, id, recoveryCodes[2] ?? ''), 'INVALID_CODE');

    await rejects(disableTotp(db, id, PASSWORD, '000000'), 'INVALID_CODE');
    await disableTotp(db, id, PASSWORD, again.recoveryCodes[0] ?? '');
    const [a] = await db.select().from(accounts);
    expect(a).toMatchObject({ twoFactorEnabled: true, twoFactorMethod: 'EMAIL' });
    expect(await db.select().from(accountTotp)).toHaveLength(0);
    expect(await db.select().from(accountRecoveryCodes)).toHaveLength(0);
    await rejects(verifyTotp(db, id, '123456'), 'NOT_ENABLED');
  });

  it('el administrador puede limpiar el TOTP de una cuenta', async () => {
    await enroll();
    await clearTotpByAdmin(db, id, id);
    expect(await db.select().from(accountTotp)).toHaveLength(0);
    expect(await db.select().from(accountRecoveryCodes)).toHaveLength(0);
  });

  it('la auditoría nunca contiene el secreto ni los códigos', async () => {
    const start = await startTotpEnroll(db, id);
    const { recoveryCodes } = await confirmTotpEnroll(db, id, await appCode());
    const dump = JSON.stringify(await db.select().from(auditLogs));
    expect(dump).not.toContain(start.manualKey.replace(/ /g, ''));
    for (const c of recoveryCodes) expect(dump).not.toContain(c);
    expect(dump).toContain('TOTP_ENROLL_CONFIRM');
  });

  it('TotpError es un Error con código', () => {
    expect(new TotpError('NOT_FOUND')).toMatchObject({ code: 'NOT_FOUND' });
  });
});
