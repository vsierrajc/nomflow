import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import type { Db } from '../db/client';
import {
  accountRecoveryCodes,
  accounts,
  accountTotp,
  auditLogs,
  twoFactorChallenges,
} from '../db/schema';
import { verifyPassword } from '../accounts/password.service';
import { open, seal } from '../security/secret-box';
import { getSessionSecret, revokeAllForAccount } from './session.service';

export const TOTP_ISSUER = 'NOMFLOW';
const TOTP_PERIOD = 30;
/** Se tolera un paso de 30 s hacia cada lado por desfase de reloj del teléfono. */
const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

export type TotpErrorCode =
  | 'ALREADY_ENABLED'
  | 'NOT_ENABLED'
  | 'NOT_PENDING'
  | 'INVALID_CODE'
  | 'INVALID_CREDENTIALS'
  | 'NOT_FOUND';

export class TotpError extends Error {
  constructor(readonly code: TotpErrorCode) {
    super(code);
  }
}

async function audit(db: Db, accountId: string | null, action: string, result: string) {
  await db.insert(auditLogs).values({
    actorAccountId: accountId,
    action,
    resource: 'two_factor',
    resourceId: accountId,
    result,
  });
}

function totpFor(email: string, secretBase32: string) {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: email,
    algorithm: 'SHA1', // lo único que Microsoft y Google Authenticator aceptan de forma fiable
    digits: 6,
    period: TOTP_PERIOD,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

const normalizeCode = (code: string) => code.replace(/[\s-]/g, '');

/** Códigos de respaldo: 50 bits aleatorios, por eso basta un HMAC con búsqueda directa (sin argon2). */
const hashRecovery = (accountId: string, code: string) =>
  createHmac('sha256', getSessionSecret())
    .update(`recovery:${accountId}:${normalizeCode(code).toUpperCase()}`)
    .digest('hex');

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I

function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

async function loadAccount(db: Db, accountId: string) {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a) throw new TotpError('NOT_FOUND');
  return a;
}

/** Códigos nuevos: reemplazan a los anteriores. Se devuelven en claro una sola vez. */
async function replaceRecoveryCodes(db: Db, accountId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
    await tx
      .insert(accountRecoveryCodes)
      .values(codes.map((c) => ({ accountId, codeHash: hashRecovery(accountId, c) })));
  });
  return codes;
}

export async function getTotpState(db: Db, accountId: string) {
  const [a] = await db
    .select({ method: accounts.twoFactorMethod, enabled: accounts.twoFactorEnabled })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountRecoveryCodes)
    .where(and(eq(accountRecoveryCodes.accountId, accountId), isNull(accountRecoveryCodes.usedAt)));
  const active = !!a?.enabled && a.method === 'TOTP';
  return { active, recoveryCodesLeft: active ? (left?.n ?? 0) : 0 };
}

/**
 * Paso 1: genera un secreto nuevo (reemplaza uno pendiente) y devuelve el QR y la clave manual.
 * El secreto solo se entrega aquí; después queda cifrado y no se vuelve a mostrar.
 */
export async function startTotpEnroll(db: Db, accountId: string) {
  const account = await loadAccount(db, accountId);
  const [existing] = await db
    .select()
    .from(accountTotp)
    .where(eq(accountTotp.accountId, accountId));
  if (existing?.confirmedAt) throw new TotpError('ALREADY_ENABLED');

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await db
    .insert(accountTotp)
    .values({ accountId, secretSealed: seal(secret) })
    .onConflictDoUpdate({
      target: accountTotp.accountId,
      set: { secretSealed: seal(secret), lastUsedStep: null, createdAt: new Date() },
    });
  const uri = totpFor(account.email, secret).toString();
  const qrDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256,
  });
  await audit(db, accountId, 'TOTP_ENROLL_START', 'SUCCESS');
  return { qrDataUrl, manualKey: secret.match(/.{1,4}/g)?.join(' ') ?? secret };
}

/** Comprueba un código TOTP y devuelve el paso (contador) en que cayó, o null. */
function matchStep(email: string, secretBase32: string, code: string): number | null {
  const token = normalizeCode(code);
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totpFor(email, secretBase32).validate({ token, window: TOTP_WINDOW });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD) + delta;
}

/** Paso 2: con un primer código correcto queda activo y se entregan los códigos de respaldo. */
export async function confirmTotpEnroll(db: Db, accountId: string, code: string) {
  const account = await loadAccount(db, accountId);
  const [row] = await db.select().from(accountTotp).where(eq(accountTotp.accountId, accountId));
  if (!row || row.confirmedAt) throw new TotpError(row ? 'ALREADY_ENABLED' : 'NOT_PENDING');

  const step = matchStep(account.email, open(row.secretSealed), code);
  if (step === null) {
    await audit(db, accountId, 'TOTP_ENROLL_CONFIRM', 'INVALID_CODE');
    throw new TotpError('INVALID_CODE');
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(accountTotp)
      .set({ confirmedAt: now, lastUsedStep: step })
      .where(eq(accountTotp.accountId, accountId));
    await tx
      .update(accounts)
      .set({
        twoFactorEnabled: true,
        twoFactorEnabledAt: account.twoFactorEnabledAt ?? now,
        twoFactorMethod: 'TOTP',
        updatedAt: now,
      })
      .where(eq(accounts.id, accountId));
  });
  const recoveryCodes = await replaceRecoveryCodes(db, accountId);
  await audit(db, accountId, 'TOTP_ENROLL_CONFIRM', 'SUCCESS');
  return { recoveryCodes };
}

/**
 * Verifica el segundo paso: código de la app o de respaldo. Un código TOTP no se acepta dos veces
 * (el paso debe ser mayor que el último usado); uno de respaldo se consume. No cuenta intentos:
 * eso lo hace el reto de ingreso o el límite del endpoint que la llame.
 */
export async function verifyTotp(
  db: Db,
  accountId: string,
  code: string,
): Promise<'TOTP' | 'RECOVERY'> {
  const account = await loadAccount(db, accountId);
  const [row] = await db.select().from(accountTotp).where(eq(accountTotp.accountId, accountId));
  if (!row?.confirmedAt || account.twoFactorMethod !== 'TOTP') throw new TotpError('NOT_ENABLED');

  const step = matchStep(account.email, open(row.secretSealed), code);
  if (step !== null) {
    const [won] = await db
      .update(accountTotp)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(accountTotp.accountId, accountId),
          or(isNull(accountTotp.lastUsedStep), lt(accountTotp.lastUsedStep, step)),
        ),
      )
      .returning({ id: accountTotp.accountId });
    if (won) {
      await audit(db, accountId, 'TOTP_VERIFY', 'SUCCESS');
      return 'TOTP';
    }
    await audit(db, accountId, 'TOTP_VERIFY', 'CODE_REUSED');
    throw new TotpError('INVALID_CODE');
  }

  const [used] = await db
    .update(accountRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(accountRecoveryCodes.accountId, accountId),
        eq(accountRecoveryCodes.codeHash, hashRecovery(accountId, code)),
        isNull(accountRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: accountRecoveryCodes.id });
  if (used) {
    await audit(db, accountId, 'TOTP_VERIFY', 'RECOVERY_CODE_USED');
    return 'RECOVERY';
  }
  await audit(db, accountId, 'TOTP_VERIFY', 'INVALID_CODE');
  throw new TotpError('INVALID_CODE');
}

/** Acción sensible: exige la clave y un código vigente (de la app o de respaldo). */
async function reauthenticate(
  db: Db,
  accountId: string,
  password: string,
  code: string,
  action: string,
) {
  const account = await loadAccount(db, accountId);
  if (!(await verifyPassword(account.passwordHash, password))) {
    await audit(db, accountId, action, 'INVALID_CREDENTIALS');
    throw new TotpError('INVALID_CREDENTIALS');
  }
  await verifyTotp(db, accountId, code);
}

/** Desactiva el TOTP y devuelve la cuenta al segundo paso por correo (sigue activado). */
export async function disableTotp(db: Db, accountId: string, password: string, code: string) {
  await reauthenticate(db, accountId, password, code, 'TOTP_DISABLE');
  await db.transaction(async (tx) => {
    await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
    await tx.delete(accountTotp).where(eq(accountTotp.accountId, accountId));
    await tx
      .update(accounts)
      .set({ twoFactorMethod: 'EMAIL', updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
  });
  await audit(db, accountId, 'TOTP_DISABLE', 'SUCCESS');
}

export async function regenerateRecoveryCodes(
  db: Db,
  accountId: string,
  password: string,
  code: string,
) {
  await reauthenticate(db, accountId, password, code, 'TOTP_RECOVERY_REGENERATE');
  const recoveryCodes = await replaceRecoveryCodes(db, accountId);
  await audit(db, accountId, 'TOTP_RECOVERY_REGENERATE', 'SUCCESS');
  return { recoveryCodes };
}

/** Borra el secreto y los códigos de respaldo (no toca las banderas de `accounts`). */
export async function clearTotpData(db: Db, accountId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(accountRecoveryCodes).where(eq(accountRecoveryCodes.accountId, accountId));
    await tx.delete(accountTotp).where(eq(accountTotp.accountId, accountId));
  });
}

/**
 * Recuperación por administrador: borra el TOTP y los códigos, apaga el doble paso y cierra las
 * sesiones. Lo llama `disableByAdmin` para que no quede un secreto huérfano.
 */
export async function clearTotpByAdmin(db: Db, actorId: string, accountId: string) {
  await clearTotpData(db, accountId);
  await revokeAllForAccount(db, accountId);
  await db.insert(auditLogs).values({
    actorAccountId: actorId,
    action: 'TOTP_CLEAR_ADMIN',
    resource: 'account',
    resourceId: accountId,
    result: 'SUCCESS',
  });
}

export const TOTP_CHALLENGE_TTL_MINUTES = 10;
export const MAX_TOTP_CHALLENGE_ATTEMPTS = 5;

/** Reto del ingreso con TOTP: no hay código que enviar, solo un identificador con intentos limitados. */
export async function issueTotpChallenge(
  db: Db,
  accountId: string,
): Promise<{ challengeId: string }> {
  const challenge = await db.transaction(async (tx) => {
    await tx
      .update(twoFactorChallenges)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(twoFactorChallenges.accountId, accountId),
          eq(twoFactorChallenges.purpose, 'LOGIN'),
          isNull(twoFactorChallenges.usedAt),
        ),
      );
    const [row] = await tx
      .insert(twoFactorChallenges)
      .values({
        accountId,
        purpose: 'LOGIN',
        method: 'TOTP',
        expiresAt: new Date(Date.now() + TOTP_CHALLENGE_TTL_MINUTES * 60_000),
      })
      .returning({ id: twoFactorChallenges.id });
    if (!row) throw new Error('reto no creado');
    return row;
  });
  return { challengeId: challenge.id };
}

/** Método del reto de ingreso vigente, o null si no existe, venció o ya se usó. */
export async function loginChallengeMethod(db: Db, challengeId: string) {
  const [c] = await db
    .select({ method: twoFactorChallenges.method })
    .from(twoFactorChallenges)
    .where(
      and(
        eq(twoFactorChallenges.id, challengeId),
        eq(twoFactorChallenges.purpose, 'LOGIN'),
        isNull(twoFactorChallenges.usedAt),
        gt(twoFactorChallenges.expiresAt, new Date()),
      ),
    );
  return c?.method ?? null;
}

/**
 * Verifica el código de un reto TOTP. Cada intento cuenta (máx. 5); con un acierto el reto se
 * consume. Devuelve la cuenta del reto.
 */
export async function verifyTotpChallenge(
  db: Db,
  challengeId: string,
  code: string,
): Promise<string> {
  const reject = async (accountId: string | null): Promise<never> => {
    await audit(db, accountId, 'TOTP_LOGIN_VERIFY', 'INVALID_CODE');
    throw new TotpError('INVALID_CODE');
  };
  const [counted] = await db
    .update(twoFactorChallenges)
    .set({ attempts: sql`${twoFactorChallenges.attempts} + 1` })
    .where(
      and(
        eq(twoFactorChallenges.id, challengeId),
        eq(twoFactorChallenges.purpose, 'LOGIN'),
        eq(twoFactorChallenges.method, 'TOTP'),
        isNull(twoFactorChallenges.usedAt),
        gt(twoFactorChallenges.expiresAt, new Date()),
        lt(twoFactorChallenges.attempts, MAX_TOTP_CHALLENGE_ATTEMPTS),
      ),
    )
    .returning({ accountId: twoFactorChallenges.accountId });
  if (!counted) return reject(null);
  try {
    await verifyTotp(db, counted.accountId, code);
  } catch (e) {
    if (e instanceof TotpError) return reject(counted.accountId);
    throw e;
  }
  const used = await db
    .update(twoFactorChallenges)
    .set({ usedAt: new Date() })
    .where(and(eq(twoFactorChallenges.id, challengeId), isNull(twoFactorChallenges.usedAt)))
    .returning({ id: twoFactorChallenges.id });
  if (used.length === 0) return reject(counted.accountId);
  return counted.accountId;
}
