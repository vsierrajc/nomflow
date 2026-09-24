import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ADMIN_ROLES, hasActiveRole } from '../auth/roles';
import { revokeAllForAccount } from '../auth/session.service';
import { accounts, auditLogs, employeeSnapshots } from '../db/schema';
import type { Mailer } from '../mail/mailer';
import { generateTemporaryPassword, hashPassword } from './password.service';
import { issueVerificationCode } from './verification.service';

export type AccountAdminErrorCode =
  'NOT_FOUND' | 'SELF' | 'FORBIDDEN' | 'CONFLICT' | 'NOT_BLOCKED' | 'NO_ACTIVE_CONTRACT';

export class AccountAdminError extends Error {
  constructor(readonly code: AccountAdminErrorCode) {
    super(code);
  }
}

export interface AccountListQuery {
  q?: string | undefined;
  status?: 'PENDIENTE_VERIFICACION' | 'ACTIVA' | 'BLOQUEADA' | undefined;
  page: number;
  pageSize: number;
}

async function audit(db: Db, actor: string, action: string, resourceId: string, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'account', resourceId, result });
}

export async function listAccounts(db: Db, query: AccountListQuery) {
  const filters: SQL[] = [];
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const cond = or(ilike(accounts.email, like), ilike(accounts.nIde, like));
    if (cond) filters.push(cond);
  }
  if (query.status) filters.push(eq(accounts.status, query.status));
  const where = filters.length ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(accounts)
    .where(where);
  const items = await db
    .select({
      id: accounts.id,
      email: accounts.email,
      nIde: accounts.nIde,
      status: accounts.status,
      mustChangePassword: accounts.mustChangePassword,
      createdAt: accounts.createdAt,
      name: sql<
        string | null
      >`(select e.nombre from employee_snapshots e where e.n_ide = "accounts"."n_ide" order by case when e.est = 'V' then 0 else 1 end limit 1)`,
      roles: sql<
        string[]
      >`coalesce((select array_agg(distinct r.role::text) from role_assignments r where r.account_id = "accounts"."id" and r.valid_from <= current_date and (r.valid_to is null or r.valid_to >= current_date)), '{}')`,
    })
    .from(accounts)
    .where(where)
    .orderBy(accounts.email)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { total: Number(total), page: query.page, pageSize: query.pageSize, items };
}

async function target(db: Db, actorId: string, id: string) {
  if (actorId === id) throw new AccountAdminError('SELF');
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!account) throw new AccountAdminError('NOT_FOUND');
  if (
    (await hasActiveRole(db, id, ADMIN_ROLES)) &&
    !(await hasActiveRole(db, actorId, ['SYSTEM_ADMIN']))
  ) {
    throw new AccountAdminError('FORBIDDEN');
  }
  return account;
}

export async function blockAccount(db: Db, actorId: string, id: string) {
  await target(db, actorId, id);
  await db
    .update(accounts)
    .set({ status: 'BLOQUEADA', updatedAt: new Date() })
    .where(eq(accounts.id, id));
  await revokeAllForAccount(db, id);
  await audit(db, actorId, 'ACCOUNT_BLOCK', id, 'SUCCESS');
}

export async function unblockAccount(db: Db, actorId: string, id: string) {
  const account = await target(db, actorId, id);
  if (account.status !== 'BLOQUEADA') throw new AccountAdminError('NOT_BLOCKED');
  const status = account.mustChangePassword ? 'PENDIENTE_VERIFICACION' : 'ACTIVA';
  try {
    await db
      .update(accounts)
      .set({ status, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(accounts.id, id));
  } catch (e) {
    if (
      (e as { code?: string }).code === '23505' ||
      (e as { cause?: { code?: string } }).cause?.code === '23505'
    ) {
      throw new AccountAdminError('CONFLICT');
    }
    throw e;
  }
  await audit(db, actorId, 'ACCOUNT_UNBLOCK', id, 'SUCCESS');
  return { status };
}

export async function resetAccountPassword(db: Db, actorId: string, id: string, mailer: Mailer) {
  const account = await target(db, actorId, id);
  if (account.status === 'BLOQUEADA') throw new AccountAdminError('CONFLICT');
  const isAdmin = await hasActiveRole(db, id, ADMIN_ROLES);
  if (!isAdmin) {
    const [active] = await db
      .select({ id: employeeSnapshots.id })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, account.nIde), eq(employeeSnapshots.est, 'V')))
      .limit(1);
    if (!active) throw new AccountAdminError('NO_ACTIVE_CONTRACT');
  }
  const temporaryPassword = generateTemporaryPassword();
  await db
    .update(accounts)
    .set({
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      status: 'PENDIENTE_VERIFICACION',
      failedAttempts: 0,
      lockedUntil: null,
      emailVerifiedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, id));
  await revokeAllForAccount(db, id);
  const verificationSent = await issueVerificationCode(db, mailer, id);
  await audit(db, actorId, 'ACCOUNT_PASSWORD_RESET', id, 'SUCCESS');
  return { temporaryPassword, verificationSent };
}
