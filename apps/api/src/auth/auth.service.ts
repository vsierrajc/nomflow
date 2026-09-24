import { and, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, employeeSnapshots, roleAssignments, sessions } from '../db/schema';
import { hashPassword, verifyPassword } from '../accounts/password.service';
import { MIN_PASSWORD_LENGTH } from '../accounts/verification.service';
import { ADMIN_ROLES, hasActiveRole } from './roles';
import type { Mailer } from '../mail/mailer';
import { createSession, markReauthenticated, type SessionMeta } from './session.service';
import { issueChallenge, verifyChallenge, TwoFactorError } from './two-factor.service';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export type LoginFailure =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'EMPLOYMENT_NOT_ACTIVE'
  | 'TWO_FACTOR_UNAVAILABLE';

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

export type LoginResult =
  | { kind: 'SESSION'; token: string; sessionId: string; accountId: string }
  /** La clave fue correcta y falta el código enviado al correo (doble paso activado). */
  | { kind: 'TWO_FACTOR'; challengeId: string };

export async function login(
  db: Db,
  emailInput: string,
  password: string,
  meta: SessionMeta,
  mailer: Mailer,
): Promise<LoginResult> {
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

  const isAdmin = await hasActiveRole(db, account.id, ADMIN_ROLES);
  if (!isAdmin) {
    const [active] = await db
      .select({ id: employeeSnapshots.id })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, account.nIde), eq(employeeSnapshots.est, 'V')))
      .limit(1);
    if (!active) return fail(db, account.id, 'EMPLOYMENT_NOT_ACTIVE');
  }

  await db
    .update(accounts)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(accounts.id, account.id));

  if (account.twoFactorEnabled) {
    // Nunca se abre sesión sin el código: si no se puede enviar, el ingreso falla.
    try {
      const { challengeId } = await issueChallenge(db, mailer, account.id, 'LOGIN');
      await audit(db, account.id, 'LOGIN', 'TWO_FACTOR_REQUIRED');
      return { kind: 'TWO_FACTOR', challengeId };
    } catch (e) {
      if (e instanceof TwoFactorError) return fail(db, account.id, 'TWO_FACTOR_UNAVAILABLE');
      throw e;
    }
  }
  return openSession(db, account.id, meta);
}

async function openSession(db: Db, accountId: string, meta: SessionMeta): Promise<LoginResult> {
  const session = await createSession(db, accountId, meta);
  await audit(db, accountId, 'LOGIN', 'SUCCESS');
  return { kind: 'SESSION', ...session, accountId };
}

/** Segundo paso del ingreso: con el código correcto se abre la sesión. */
export async function completeTwoFactorLogin(
  db: Db,
  challengeId: string,
  code: string,
  meta: SessionMeta,
): Promise<LoginResult> {
  let accountId: string;
  try {
    accountId = await verifyChallenge(db, challengeId, 'LOGIN', code);
  } catch (e) {
    if (e instanceof TwoFactorError) return fail(db, null, 'INVALID_CREDENTIALS');
    throw e;
  }
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  // Lo que pudo cambiar entre los dos pasos (bloqueo, baja) se vuelve a comprobar.
  if (!account || account.status !== 'ACTIVA') return fail(db, accountId, 'ACCOUNT_NOT_ACTIVE');
  const isAdmin = await hasActiveRole(db, accountId, ADMIN_ROLES);
  if (!isAdmin) {
    const [active] = await db
      .select({ id: employeeSnapshots.id })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, account.nIde), eq(employeeSnapshots.est, 'V')))
      .limit(1);
    if (!active) return fail(db, accountId, 'EMPLOYMENT_NOT_ACTIVE');
  }
  return openSession(db, accountId, meta);
}

export async function reauthenticate(
  db: Db,
  accountId: string,
  sessionId: string,
  password: string,
): Promise<void> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account || (account.lockedUntil && account.lockedUntil.getTime() > Date.now())) {
    return fail(db, accountId, 'ACCOUNT_LOCKED');
  }
  if (!(await verifyPassword(account.passwordHash, password))) {
    await db
      .update(accounts)
      .set({
        failedAttempts: sql`${accounts.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${accounts.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE ${accounts.lockedUntil} END`,
      })
      .where(eq(accounts.id, accountId));
    await audit(db, accountId, 'REAUTH', 'INVALID_CREDENTIALS');
    throw new LoginError('INVALID_CREDENTIALS');
  }
  await markReauthenticated(db, sessionId);
  await audit(db, accountId, 'REAUTH', 'SUCCESS');
}

export type ChangePasswordFailure = 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'WEAK_PASSWORD';

export class ChangePasswordError extends Error {
  constructor(readonly reason: ChangePasswordFailure) {
    super(reason);
  }
}

export async function changePassword(
  db: Db,
  accountId: string,
  sessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const reject = async (reason: ChangePasswordFailure): Promise<never> => {
    await audit(db, accountId, 'PASSWORD_CHANGE', reason);
    throw new ChangePasswordError(reason);
  };
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account || (account.lockedUntil && account.lockedUntil.getTime() > Date.now())) {
    return reject('ACCOUNT_LOCKED');
  }
  if (!(await verifyPassword(account.passwordHash, currentPassword))) {
    await db
      .update(accounts)
      .set({
        failedAttempts: sql`${accounts.failedAttempts} + 1`,
        lockedUntil: sql`CASE WHEN ${accounts.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE ${accounts.lockedUntil} END`,
      })
      .where(eq(accounts.id, accountId));
    return reject('INVALID_CREDENTIALS');
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword === currentPassword) {
    return reject('WEAK_PASSWORD');
  }

  const newHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(accounts)
      .set({
        passwordHash: newHash,
        mustChangePassword: false,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.accountId, accountId),
          ne(sessions.id, sessionId),
          isNull(sessions.revokedAt),
        ),
      );
  });
  await audit(db, accountId, 'PASSWORD_CHANGE', 'SUCCESS');
}

export interface Profile {
  accountId: string;
  email: string;
  name: string | null;
  twoFactorEnabled: boolean;
  roles: {
    role: string;
    cEmp: string | null;
    areaCode: string | null;
    validFrom: string;
    validTo: string | null;
  }[];
}

export async function getProfile(db: Db, accountId: string): Promise<Profile> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
  if (!account) throw new Error('cuenta inexistente');
  const [employee] = await db
    .select({ nombre: employeeSnapshots.nombre })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, account.nIde), eq(employeeSnapshots.est, 'V')))
    .limit(1);
  const today = new Date().toISOString().slice(0, 10);
  const roles = await db
    .select({
      role: roleAssignments.role,
      cEmp: roleAssignments.companyCode,
      areaCode: roleAssignments.areaCode,
      validFrom: roleAssignments.validFrom,
      validTo: roleAssignments.validTo,
    })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        lte(roleAssignments.validFrom, today),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)),
      ),
    );
  return {
    accountId,
    email: account.email,
    name: employee?.nombre ?? null,
    twoFactorEnabled: account.twoFactorEnabled,
    roles,
  };
}
