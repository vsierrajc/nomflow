import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ADMIN_ROLES, hasActiveRole } from '../auth/roles';
import { accounts, auditLogs, employeeSnapshots } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import { validAssignedPassword } from './accounts-admin.service';
import { issueVerificationCode } from './verification.service';
import { generateTemporaryPassword, hashPassword } from './password.service';

export type AccountErrorCode =
  | 'FORBIDDEN'
  | 'EMPLOYEE_NOT_FOUND'
  | 'NO_ACTIVE_CONTRACT'
  | 'EMAIL_MISSING'
  | 'ACCOUNT_EXISTS'
  | 'WEAK_PASSWORD';

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
  }
}

export interface CreatedAccount {
  accountId: string;
  /** Clave generada por el sistema. Vacía si el administrador eligió la clave: esa no se devuelve. */
  temporaryPassword: string;
  verificationSent: boolean;
}

export async function createAccountByAdmin(
  db: Db,
  actorAccountId: string,
  nIde: string,
  mailer: Mailer,
  chosenPassword?: string,
): Promise<CreatedAccount> {
  try {
    const base = await create(db, actorAccountId, nIde, chosenPassword);
    const verificationSent = await issueVerificationCode(db, mailer, base.accountId);
    const created = { ...base, verificationSent };
    await audit(db, actorAccountId, 'ACCOUNT_CREATE', 'SUCCESS', created.accountId, nIde);
    return created;
  } catch (e) {
    if (e instanceof AccountError) {
      await audit(db, actorAccountId, 'ACCOUNT_CREATE', e.code, null, nIde);
    }
    throw e;
  }
}

async function create(
  db: Db,
  actorAccountId: string,
  nIde: string,
  chosenPassword?: string,
): Promise<Omit<CreatedAccount, 'verificationSent'>> {
  if (!(await hasActiveRole(db, actorAccountId, ADMIN_ROLES))) {
    throw new AccountError('FORBIDDEN');
  }

  const rows = await db.select().from(employeeSnapshots).where(eq(employeeSnapshots.nIde, nIde));
  if (rows.length === 0) throw new AccountError('EMPLOYEE_NOT_FOUND');
  const active = rows.filter((r) => r.est === 'V');
  if (active.length !== 1) throw new AccountError('NO_ACTIVE_CONTRACT');
  const email = active[0]?.email.trim().toLowerCase() ?? '';
  if (!email) throw new AccountError('EMAIL_MISSING');

  if (chosenPassword !== undefined && !validAssignedPassword(chosenPassword, email))
    throw new AccountError('WEAK_PASSWORD');
  const temporaryPassword = chosenPassword === undefined ? generateTemporaryPassword() : '';
  const passwordHash = await hashPassword(chosenPassword ?? temporaryPassword);
  try {
    const [row] = await db
      .insert(accounts)
      .values({ nIde, email, passwordHash })
      .returning({ id: accounts.id });
    if (!row) throw new Error('insert sin resultado');
    return { accountId: row.id, temporaryPassword };
  } catch (e) {
    if (
      (e as { code?: string }).code === '23505' ||
      (e as { cause?: { code?: string } }).cause?.code === '23505'
    ) {
      throw new AccountError('ACCOUNT_EXISTS');
    }
    throw e;
  }
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  result: string,
  resourceId: string | null,
  nIde: string,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'account',
    resourceId,
    result,
    context: { nIdeSuffix: nIde.slice(-3) },
  });
}
