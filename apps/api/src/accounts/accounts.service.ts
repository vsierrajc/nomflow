import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, employeeSnapshots, roleAssignments } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import { issueVerificationCode } from './verification.service';
import { generateTemporaryPassword, hashPassword } from './password.service';

export type AccountErrorCode =
  'FORBIDDEN' | 'EMPLOYEE_NOT_FOUND' | 'NO_ACTIVE_CONTRACT' | 'EMAIL_MISSING' | 'ACCOUNT_EXISTS';

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
  }
}

export interface CreatedAccount {
  accountId: string;
  temporaryPassword: string;
  verificationSent: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function createAccountByAdmin(
  db: Db,
  actorAccountId: string,
  nIde: string,
  mailer: Mailer,
): Promise<CreatedAccount> {
  try {
    const base = await create(db, actorAccountId, nIde);
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
): Promise<Omit<CreatedAccount, 'verificationSent'>> {
  const d = today();
  const roles = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, actorAccountId),
        eq(roleAssignments.role, 'HR_ADMIN'),
        lte(roleAssignments.validFrom, d),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, d)),
      ),
    )
    .limit(1);
  if (roles.length === 0) throw new AccountError('FORBIDDEN');

  const rows = await db.select().from(employeeSnapshots).where(eq(employeeSnapshots.nIde, nIde));
  if (rows.length === 0) throw new AccountError('EMPLOYEE_NOT_FOUND');
  const active = rows.filter((r) => r.est === 'V');
  if (active.length !== 1) throw new AccountError('NO_ACTIVE_CONTRACT');
  const email = active[0]?.email.trim().toLowerCase() ?? '';
  if (!email) throw new AccountError('EMAIL_MISSING');

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
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
