import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, employeeSnapshots } from '../db/schema';
import { hashPassword, verifyPassword } from '../accounts/password.service';
import { createSession, type SessionMeta } from './session.service';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export type LoginFailure =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'EMPLOYMENT_NOT_ACTIVE';

export class LoginError extends Error {
  constructor(readonly reason: LoginFailure) {
    super(reason);
  }
}

let dummyHash: Promise<string> | undefined;

async function audit(db: Db, accountId: string | null, action: string, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: accountId, action, resource: 'session', result });
}

async function fail(db: Db, accountId: string | null, reason: LoginFailure): Promise<never> {
  await audit(db, accountId, 'LOGIN', reason);
  throw new LoginError(reason);
}

export async function login(
  db: Db,
  emailInput: string,
  password: string,
  meta: SessionMeta,
): Promise<{ token: string; sessionId: string; accountId: string }> {
  const email = emailInput.trim().toLowerCase();
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.email, email), sql`${accounts.status} <> 'BLOQUEADA'`));

  if (!account) {
    dummyHash ??= hashPassword('nomflow-dummy-password');
    await verifyPassword(await dummyHash, password);
    return fail(db, null, 'INVALID_CREDENTIALS');
  }

  if (account.lockedUntil && account.lockedUntil.getTime() > Date.now()) {
    return fail(db, account.id, 'ACCOUNT_LOCKED');
  }

  if (!(await verifyPassword(account.passwordHash, password))) {
    await db
      .update(accounts)
      .set({
        failedAttempts: sql`${accounts.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${accounts.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE ${accounts.lockedUntil} END`,
      })
      .where(eq(accounts.id, account.id));
    return fail(db, account.id, 'INVALID_CREDENTIALS');
  }

  if (account.status !== 'ACTIVA') return fail(db, account.id, 'ACCOUNT_NOT_ACTIVE');
  if (account.mustChangePassword) return fail(db, account.id, 'PASSWORD_CHANGE_REQUIRED');

  const [active] = await db
    .select({ id: employeeSnapshots.id })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, account.nIde), eq(employeeSnapshots.est, 'V')))
    .limit(1);
  if (!active) return fail(db, account.id, 'EMPLOYMENT_NOT_ACTIVE');

  await db
    .update(accounts)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(accounts.id, account.id));
  const session = await createSession(db, account.id, meta);
  await audit(db, account.id, 'LOGIN', 'SUCCESS');
  return { ...session, accountId: account.id };
}
