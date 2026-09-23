import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, catalogEntries, roleAssignments } from '../db/schema';
import { hasActiveRole, type RoleName } from '../auth/roles';

export type OrgErrorCode =
  | 'FORBIDDEN'
  | 'ACCOUNT_NOT_FOUND'
  | 'SELF_GRANT'
  | 'SCOPE_REQUIRED'
  | 'INVALID_RANGE'
  | 'AREA_NOT_FOUND'
  | 'MANAGER_NOT_ELIGIBLE'
  | 'OVERLAP'
  | 'NOT_FOUND';

export class OrgError extends Error {
  constructor(readonly code: OrgErrorCode) {
    super(code);
  }
}

const PRIVILEGED: readonly RoleName[] = ['HR_ADMIN', 'SYSTEM_ADMIN'];

export function validRange(from: string, to: string | null | undefined): boolean {
  const ok = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  };
  return ok(from) && (to == null || (ok(to) && to >= from));
}

export async function areaExists(
  db: Pick<Db, 'select'>,
  cEmp: string,
  cArea: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: catalogEntries.id })
    .from(catalogEntries)
    .where(
      and(
        eq(catalogEntries.type, 'AREA'),
        eq(catalogEntries.cEmp, cEmp),
        eq(catalogEntries.code, cArea),
        eq(catalogEntries.active, true),
      ),
    );
  return Boolean(row);
}

export interface GrantInput {
  role: RoleName;
  cEmp?: string | undefined;
  areaCode?: string | undefined;
  validFrom: string;
  validTo?: string | null | undefined;
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'role_assignment', resourceId, result });
}

export async function grantRole(
  db: Db,
  actorId: string,
  targetId: string,
  input: GrantInput,
): Promise<{ id: string }> {
  const fail = async (code: OrgErrorCode): Promise<never> => {
    await audit(db, actorId, 'ROLE_GRANT', targetId, code);
    throw new OrgError(code);
  };
  if (!(await hasActiveRole(db, actorId, ['HR_ADMIN', 'SYSTEM_ADMIN']))) return fail('FORBIDDEN');
  if (actorId === targetId) return fail('SELF_GRANT');
  if (PRIVILEGED.includes(input.role) && !(await hasActiveRole(db, actorId, ['SYSTEM_ADMIN'])))
    return fail('FORBIDDEN');
  if (!validRange(input.validFrom, input.validTo)) return fail('INVALID_RANGE');

  const [target] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, targetId));
  if (!target) return fail('ACCOUNT_NOT_FOUND');

  if (input.role === 'AREA_MANAGER') {
    if (!input.cEmp || !input.areaCode) return fail('SCOPE_REQUIRED');
    if (!(await areaExists(db, input.cEmp, input.areaCode))) return fail('AREA_NOT_FOUND');
  }
  const [row] = await db
    .insert(roleAssignments)
    .values({
      accountId: targetId,
      role: input.role,
      companyCode: input.cEmp ?? null,
      areaCode: input.areaCode ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    })
    .returning({ id: roleAssignments.id });
  if (!row) throw new Error('rol no creado');
  await audit(db, actorId, 'ROLE_GRANT', row.id, 'SUCCESS');
  return row;
}

export async function listRoles(db: Db, accountId: string) {
  return db.select().from(roleAssignments).where(eq(roleAssignments.accountId, accountId));
}
