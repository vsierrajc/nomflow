import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { roleAssignments } from '../db/schema';

export type RoleName = (typeof roleAssignments.$inferSelect)['role'];

export const ADMIN_ROLES: readonly RoleName[] = ['HR_ADMIN', 'SYSTEM_ADMIN'];

/** Empresas donde la cuenta tiene el rol vigente (solo asignaciones con empresa; sin empresa no da acceso). */
export async function activeCompaniesForRole(
  db: Db,
  accountId: string,
  role: RoleName,
): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ c: roleAssignments.companyCode })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.role, role),
        lte(roleAssignments.validFrom, today),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)),
      ),
    );
  return [...new Set(rows.flatMap((r) => (r.c ? [r.c] : [])))];
}

export async function hasActiveRole(
  db: Db,
  accountId: string,
  roles: readonly RoleName[],
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        inArray(roleAssignments.role, [...roles]),
        lte(roleAssignments.validFrom, today),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
