import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, areaManagerAssignments, auditLogs, roleAssignments } from '../db/schema';
import { hasActiveRole } from '../auth/roles';
import { OrgError, areaExists, validRange } from './roles.service';

export interface AssignInput {
  cEmp: string;
  cArea: string;
  managerAccountId: string;
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
    .values({ actorAccountId: actor, action, resource: 'area_manager', resourceId, result });
}

export async function assignAreaManager(
  db: Db,
  actorId: string,
  input: AssignInput,
): Promise<{ id: string }> {
  const fail = async (code: OrgError['code']): Promise<never> => {
    await audit(db, actorId, 'AREA_MANAGER_ASSIGN', null, code);
    throw new OrgError(code);
  };
  if (!(await hasActiveRole(db, actorId, ['HR_ADMIN', 'SYSTEM_ADMIN']))) return fail('FORBIDDEN');
  if (!validRange(input.validFrom, input.validTo)) return fail('INVALID_RANGE');
  if (!(await areaExists(db, input.cEmp, input.cArea))) return fail('AREA_NOT_FOUND');

  const end = input.validTo ?? null;
  const created = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`area-manager:${input.cEmp}:${input.cArea}`}))`,
    );

    const [manager] = await tx
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, input.managerAccountId));
    if (!manager || manager.status !== 'ACTIVA') return 'MANAGER_NOT_ELIGIBLE' as const;

    const roleWhere = [
      eq(roleAssignments.accountId, input.managerAccountId),
      eq(roleAssignments.role, 'AREA_MANAGER'),
      eq(roleAssignments.companyCode, input.cEmp),
      eq(roleAssignments.areaCode, input.cArea),
      lte(roleAssignments.validFrom, input.validFrom),
      end === null
        ? isNull(roleAssignments.validTo)
        : or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, end)),
    ];
    const [role] = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(and(...roleWhere))
      .limit(1);
    if (!role) return 'MANAGER_NOT_ELIGIBLE' as const;

    const [overlap] = await tx
      .select({ id: areaManagerAssignments.id })
      .from(areaManagerAssignments)
      .where(
        and(
          eq(areaManagerAssignments.cEmp, input.cEmp),
          eq(areaManagerAssignments.cArea, input.cArea),
          or(
            isNull(areaManagerAssignments.validTo),
            gte(areaManagerAssignments.validTo, input.validFrom),
          ),
          end === null ? sql`true` : lte(areaManagerAssignments.validFrom, end),
        ),
      )
      .limit(1);
    if (overlap) return 'OVERLAP' as const;

    const [row] = await tx
      .insert(areaManagerAssignments)
      .values({
        cEmp: input.cEmp,
        cArea: input.cArea,
        managerAccountId: input.managerAccountId,
        validFrom: input.validFrom,
        validTo: end,
        createdBy: actorId,
      })
      .returning({ id: areaManagerAssignments.id });
    return row ?? null;
  });
  if (typeof created === 'string') return fail(created);
  if (!created) throw new Error('asignación no creada');
  await audit(db, actorId, 'AREA_MANAGER_ASSIGN', created.id, 'SUCCESS');
  return created;
}

export async function endAreaManager(
  db: Db,
  actorId: string,
  id: string,
  validTo: string,
): Promise<void> {
  if (!(await hasActiveRole(db, actorId, ['HR_ADMIN', 'SYSTEM_ADMIN'])))
    throw new OrgError('FORBIDDEN');
  const [row] = await db
    .select()
    .from(areaManagerAssignments)
    .where(eq(areaManagerAssignments.id, id));
  if (!row) throw new OrgError('NOT_FOUND');
  if (!validRange(row.validFrom, validTo) || (row.validTo !== null && validTo > row.validTo))
    throw new OrgError('INVALID_RANGE');
  await db.update(areaManagerAssignments).set({ validTo }).where(eq(areaManagerAssignments.id, id));
  await audit(db, actorId, 'AREA_MANAGER_END', id, 'SUCCESS');
}

export async function listAreaManagers(db: Db, cEmp: string, cArea: string) {
  return db
    .select()
    .from(areaManagerAssignments)
    .where(and(eq(areaManagerAssignments.cEmp, cEmp), eq(areaManagerAssignments.cArea, cArea)))
    .orderBy(areaManagerAssignments.validFrom);
}

export async function resolveAreaManager(
  db: Db,
  cEmp: string,
  cArea: string,
  date: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: areaManagerAssignments.managerAccountId })
    .from(areaManagerAssignments)
    .innerJoin(accounts, eq(accounts.id, areaManagerAssignments.managerAccountId))
    .where(
      and(
        eq(areaManagerAssignments.cEmp, cEmp),
        eq(areaManagerAssignments.cArea, cArea),
        lte(areaManagerAssignments.validFrom, date),
        or(isNull(areaManagerAssignments.validTo), gte(areaManagerAssignments.validTo, date)),
        eq(accounts.status, 'ACTIVA'),
      ),
    );
  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}
