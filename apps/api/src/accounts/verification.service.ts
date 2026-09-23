import { createHmac, randomInt } from 'node:crypto';
import { and, desc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, employeeSnapshots, verificationCodes } from '../db/schema';
import { getSessionSecret, revokeAllForAccount } from '../auth/session.service';
import type { Mailer } from '../mail/mailer';
import { hashPassword, verifyPassword } from './password.service';

export const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 3;
export const MIN_PASSWORD_LENGTH = 12;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type ActivationFailure =
  | 'INVALID_INPUT'
  | 'ACCOUNT_NOT_PENDING'
  | 'BAD_TEMPORARY_PASSWORD'
  | 'NO_VALID_CODE'
  | 'BAD_CODE'
  | 'EMPLOYMENT_NOT_ACTIVE';

export class ActivationError extends Error {
  constructor(readonly reason: ActivationFailure) {
    super(reason);
  }
}

const normalizeCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
const hashCode = (code: string) =>
  createHmac('sha256', getSessionSecret()).update(normalizeCode(code)).digest('hex');

function generateCode(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

async function audit(db: Db, accountId: string | null, action: string, result: string) {
  await db.insert(auditLogs).values({
    actorAccountId: accountId,
    action,
    resource: 'account',
    resourceId: accountId,
    result,
  });
}

export async function issueVerificationCode(
  db: Db,
  mailer: Mailer,
  accountId: string,
): Promise<boolean> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account || account.status !== 'PENDIENTE_VERIFICACION') return false;

  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.accountId, accountId),
        gte(verificationCodes.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) {
    await audit(db, accountId, 'VERIFICATION_CODE_SEND', 'RATE_LIMITED');
    return false;
  }

  const code = generateCode();
  await db.transaction(async (tx) => {
    await tx
      .update(verificationCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(verificationCodes.accountId, accountId), isNull(verificationCodes.usedAt)));
    await tx.insert(verificationCodes).values({
      accountId,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    });
  });

  try {
    await mailer.send(
      account.email,
      'NOMFLOW: código de verificación',
      `Su código de verificación de NOMFLOW es ${code}.\n` +
        `Vence en ${CODE_TTL_MINUTES} minutos y solo sirve una vez.\n` +
        'Si no esperaba este mensaje, ignórelo.',
    );
  } catch {
    await audit(db, accountId, 'VERIFICATION_CODE_SEND', 'MAIL_FAILED');
    return false;
  }
  await audit(db, accountId, 'VERIFICATION_CODE_SEND', 'SUCCESS');
  return true;
}

export async function resendVerificationCode(
  db: Db,
  mailer: Mailer,
  emailInput: string,
): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.email, email), eq(accounts.status, 'PENDIENTE_VERIFICACION')));
  if (account) await issueVerificationCode(db, mailer, account.id);
}

let dummyHash: Promise<string> | undefined;

async function reject(db: Db, accountId: string | null, reason: ActivationFailure): Promise<never> {
  await audit(db, accountId, 'ACCOUNT_ACTIVATE', reason);
  throw new ActivationError(reason);
}

export interface ActivationInput {
  email: string;
  temporaryPassword: string;
  code: string;
  newPassword: string;
}

export async function activateAccount(db: Db, input: ActivationInput): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (
    input.newPassword.length < MIN_PASSWORD_LENGTH ||
    input.newPassword === input.temporaryPassword
  ) {
    return reject(db, null, 'INVALID_INPUT');
  }

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.email, email), eq(accounts.status, 'PENDIENTE_VERIFICACION')));
  if (!account) {
    dummyHash ??= hashPassword('nomflow-dummy-password');
    await verifyPassword(await dummyHash, input.temporaryPassword);
    return reject(db, null, 'ACCOUNT_NOT_PENDING');
  }

  if (account.lockedUntil && account.lockedUntil.getTime() > Date.now()) {
    return reject(db, account.id, 'BAD_TEMPORARY_PASSWORD');
  }
  if (!(await verifyPassword(account.passwordHash, input.temporaryPassword))) {
    await db
      .update(accounts)
      .set({
        failedAttempts: sql`${accounts.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${accounts.failedAttempts} + 1 >= 5
          THEN now() + interval '15 minutes' ELSE ${accounts.lockedUntil} END`,
      })
      .where(eq(accounts.id, account.id));
    return reject(db, account.id, 'BAD_TEMPORARY_PASSWORD');
  }

  const [code] = await db
    .select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.accountId, account.id),
        isNull(verificationCodes.usedAt),
        gt(verificationCodes.expiresAt, new Date()),
        lt(verificationCodes.attempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .orderBy(desc(verificationCodes.createdAt))
    .limit(1);
  if (!code) return reject(db, account.id, 'NO_VALID_CODE');

  const [counted] = await db
    .update(verificationCodes)
    .set({ attempts: sql`${verificationCodes.attempts} + 1` })
    .where(
      and(
        eq(verificationCodes.id, code.id),
        isNull(verificationCodes.usedAt),
        lt(verificationCodes.attempts, MAX_CODE_ATTEMPTS),
      ),
    )
    .returning({ id: verificationCodes.id });
  if (!counted) return reject(db, account.id, 'NO_VALID_CODE');
  if (hashCode(input.code) !== code.codeHash) return reject(db, account.id, 'BAD_CODE');

  const [active] = await db
    .select({ id: employeeSnapshots.id })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, account.nIde), eq(employeeSnapshots.est, 'V')))
    .limit(1);
  if (!active) return reject(db, account.id, 'EMPLOYMENT_NOT_ACTIVE');

  const newHash = await hashPassword(input.newPassword);
  const consumed = await db.transaction(async (tx) => {
    const used = await tx
      .update(verificationCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(verificationCodes.id, code.id), isNull(verificationCodes.usedAt)))
      .returning({ id: verificationCodes.id });
    if (used.length === 0) return false;
    await tx
      .update(accounts)
      .set({
        passwordHash: newHash,
        mustChangePassword: false,
        status: 'ACTIVA',
        emailVerifiedAt: new Date(),
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id));
    return true;
  });
  if (!consumed) return reject(db, account.id, 'NO_VALID_CODE');
  await revokeAllForAccount(db, account.id);
  await audit(db, account.id, 'ACCOUNT_ACTIVATE', 'SUCCESS');
}
