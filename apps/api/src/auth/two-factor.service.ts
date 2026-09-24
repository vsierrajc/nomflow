import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, twoFactorChallenges } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import { verifyPassword } from '../accounts/password.service';
import { getSessionSecret, revokeAllForAccount } from './session.service';

export const TWO_FACTOR_TTL_MINUTES = 10;
export const MAX_CHALLENGE_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR: Record<Purpose, number> = { LOGIN: 5, ENABLE: 3 };

export type Purpose = 'LOGIN' | 'ENABLE';
export type TwoFactorErrorCode =
  | 'RATE_LIMITED'
  | 'MAIL_FAILED'
  | 'INVALID_CODE'
  | 'ALREADY_ENABLED'
  | 'NOT_ENABLED'
  | 'INVALID_CREDENTIALS'
  | 'NOT_FOUND';

export class TwoFactorError extends Error {
  constructor(readonly code: TwoFactorErrorCode) {
    super(code);
  }
}

/** Código numérico de 6 dígitos, de un solo uso. */
const generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** El hash liga el código a la cuenta y al propósito: no sirve para otra cosa. */
const hashCode = (accountId: string, purpose: Purpose, code: string) =>
  createHmac('sha256', getSessionSecret())
    .update(`2fa:${purpose}:${accountId}:${code.replace(/\s/g, '')}`)
    .digest('hex');

const equalHex = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function audit(db: Db, accountId: string | null, action: string, result: string) {
  await db.insert(auditLogs).values({
    actorAccountId: accountId,
    action,
    resource: 'two_factor',
    resourceId: accountId,
    result,
  });
}

/** Crea el reto, envía el código al correo de la cuenta y devuelve el identificador del reto. */
export async function issueChallenge(
  db: Db,
  mailer: Mailer,
  accountId: string,
  purpose: Purpose,
): Promise<{ challengeId: string }> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new TwoFactorError('NOT_FOUND');

  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(twoFactorChallenges)
    .where(
      and(
        eq(twoFactorChallenges.accountId, accountId),
        eq(twoFactorChallenges.purpose, purpose),
        gte(twoFactorChallenges.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR[purpose]) {
    await audit(db, accountId, `TWO_FACTOR_${purpose}_SEND`, 'RATE_LIMITED');
    throw new TwoFactorError('RATE_LIMITED');
  }

  const code = generateCode();
  const challenge = await db.transaction(async (tx) => {
    await tx
      .update(twoFactorChallenges)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(twoFactorChallenges.accountId, accountId),
          eq(twoFactorChallenges.purpose, purpose),
          isNull(twoFactorChallenges.usedAt),
        ),
      );
    const [row] = await tx
      .insert(twoFactorChallenges)
      .values({
        accountId,
        purpose,
        codeHash: hashCode(accountId, purpose, code),
        expiresAt: new Date(Date.now() + TWO_FACTOR_TTL_MINUTES * 60_000),
      })
      .returning({ id: twoFactorChallenges.id });
    if (!row) throw new Error('reto no creado');
    return row;
  });

  try {
    await mailer.send(
      account.email,
      'NOMFLOW: código de verificación en dos pasos',
      `Su código de NOMFLOW es ${code}.\n` +
        `Vence en ${TWO_FACTOR_TTL_MINUTES} minutos y solo sirve una vez.\n` +
        (purpose === 'LOGIN'
          ? 'Si usted no intentó ingresar, alguien conoce su clave: cámbiela y avise a Gestión Humana.'
          : 'Es para activar la verificación en dos pasos de su cuenta. Si no lo solicitó, ignore este mensaje.'),
    );
  } catch {
    await db
      .update(twoFactorChallenges)
      .set({ usedAt: new Date() })
      .where(eq(twoFactorChallenges.id, challenge.id));
    await audit(db, accountId, `TWO_FACTOR_${purpose}_SEND`, 'MAIL_FAILED');
    throw new TwoFactorError('MAIL_FAILED');
  }
  await audit(db, accountId, `TWO_FACTOR_${purpose}_SEND`, 'SUCCESS');
  return { challengeId: challenge.id };
}

/**
 * Comprueba el código de un reto. Cada intento cuenta; agotados los intentos, el vencimiento o el
 * uso, el reto deja de servir y hay que empezar de nuevo. Devuelve la cuenta a la que pertenece.
 */
export async function verifyChallenge(
  db: Db,
  challengeId: string,
  purpose: Purpose,
  code: string,
  expectedAccountId?: string,
): Promise<string> {
  const reject = async (accountId: string | null): Promise<never> => {
    await audit(db, accountId, `TWO_FACTOR_${purpose}_VERIFY`, 'INVALID_CODE');
    throw new TwoFactorError('INVALID_CODE');
  };
  const [challenge] = await db
    .select()
    .from(twoFactorChallenges)
    .where(
      and(
        eq(twoFactorChallenges.id, challengeId),
        eq(twoFactorChallenges.purpose, purpose),
        isNull(twoFactorChallenges.usedAt),
        gt(twoFactorChallenges.expiresAt, new Date()),
        lt(twoFactorChallenges.attempts, MAX_CHALLENGE_ATTEMPTS),
      ),
    )
    .orderBy(desc(twoFactorChallenges.createdAt))
    .limit(1);
  if (!challenge) return reject(null);
  if (expectedAccountId && challenge.accountId !== expectedAccountId) return reject(null);

  const [counted] = await db
    .update(twoFactorChallenges)
    .set({ attempts: sql`${twoFactorChallenges.attempts} + 1` })
    .where(
      and(
        eq(twoFactorChallenges.id, challenge.id),
        isNull(twoFactorChallenges.usedAt),
        lt(twoFactorChallenges.attempts, MAX_CHALLENGE_ATTEMPTS),
      ),
    )
    .returning({ id: twoFactorChallenges.id });
  if (!counted) return reject(challenge.accountId);
  if (!equalHex(hashCode(challenge.accountId, purpose, code), challenge.codeHash))
    return reject(challenge.accountId);

  const used = await db
    .update(twoFactorChallenges)
    .set({ usedAt: new Date() })
    .where(and(eq(twoFactorChallenges.id, challenge.id), isNull(twoFactorChallenges.usedAt)))
    .returning({ id: twoFactorChallenges.id });
  if (used.length === 0) return reject(challenge.accountId);
  await audit(db, challenge.accountId, `TWO_FACTOR_${purpose}_VERIFY`, 'SUCCESS');
  return challenge.accountId;
}

export async function getState(db: Db, accountId: string) {
  const [a] = await db
    .select({ enabled: accounts.twoFactorEnabled, enabledAt: accounts.twoFactorEnabledAt })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return { enabled: a?.enabled ?? false, enabledAt: a?.enabledAt ?? null };
}

/** Paso 1 de la activación: envía un código al correo para comprobar que se controla ese buzón. */
export async function startEnable(db: Db, mailer: Mailer, accountId: string) {
  if ((await getState(db, accountId)).enabled) throw new TwoFactorError('ALREADY_ENABLED');
  return issueChallenge(db, mailer, accountId, 'ENABLE');
}

/** Paso 2: con el código correcto queda activado. */
export async function confirmEnable(db: Db, accountId: string, challengeId: string, code: string) {
  if ((await getState(db, accountId)).enabled) throw new TwoFactorError('ALREADY_ENABLED');
  await verifyChallenge(db, challengeId, 'ENABLE', code, accountId);
  await db
    .update(accounts)
    .set({ twoFactorEnabled: true, twoFactorEnabledAt: new Date(), updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  await audit(db, accountId, 'TWO_FACTOR_ENABLE', 'SUCCESS');
}

/** El propio usuario lo desactiva confirmando con su clave. */
export async function disableOwn(db: Db, accountId: string, password: string) {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a) throw new TwoFactorError('NOT_FOUND');
  if (!a.twoFactorEnabled) throw new TwoFactorError('NOT_ENABLED');
  if (!(await verifyPassword(a.passwordHash, password))) {
    await audit(db, accountId, 'TWO_FACTOR_DISABLE', 'INVALID_CREDENTIALS');
    throw new TwoFactorError('INVALID_CREDENTIALS');
  }
  await db
    .update(accounts)
    .set({ twoFactorEnabled: false, twoFactorEnabledAt: null, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  await audit(db, accountId, 'TWO_FACTOR_DISABLE', 'SUCCESS');
}

/** Recuperación: un administrador lo desactiva (p. ej. el empleado perdió el acceso al correo). */
export async function disableByAdmin(db: Db, actorId: string, accountId: string) {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!a) throw new TwoFactorError('NOT_FOUND');
  if (!a.twoFactorEnabled) throw new TwoFactorError('NOT_ENABLED');
  await db
    .update(accounts)
    .set({ twoFactorEnabled: false, twoFactorEnabledAt: null, updatedAt: new Date() })
    .where(eq(accounts.id, accountId));
  await revokeAllForAccount(db, accountId);
  await db.insert(auditLogs).values({
    actorAccountId: actorId,
    action: 'TWO_FACTOR_DISABLE_ADMIN',
    resource: 'account',
    resourceId: accountId,
    result: 'SUCCESS',
  });
}
