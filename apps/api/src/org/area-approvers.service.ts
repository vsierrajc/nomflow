import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  areaManagerAssignments,
  auditLogs,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { ADMIN_ROLES, hasActiveRole } from '../auth/roles';
import { OrgError, areaExists } from './roles.service';
import { todayBogota } from '../common/dates';
import { addDays } from '../leave/business-days';

export interface AreaApproversInput {
  /** Cuenta que pasa a ser jefe del área; `null` la deja sin jefe; ausente no la cambia. */
  managerAccountId?: string | null | undefined;
  /** Igual para el director del área. */
  directorAccountId?: string | null | undefined;
}

const todayIso = () => todayBogota();
const yesterdayIso = () => addDays(todayBogota(), -1);

type Runner = Pick<Db, 'select' | 'insert' | 'update'>;

async function person(db: Runner, accountId: string) {
  const [row] = await db
    .select({ accountId: accounts.id, email: accounts.email, nIde: accounts.nIde })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!row) return null;
  const [emp] = await db
    .select({ nombre: employeeSnapshots.nombre })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, row.nIde), eq(employeeSnapshots.est, 'V')))
    .limit(1);
  return { ...row, name: emp?.nombre ?? row.email };
}

async function currentManagerRows(db: Runner, cEmp: string, cArea: string) {
  const t = todayIso();
  return db
    .select()
    .from(areaManagerAssignments)
    .where(
      and(
        eq(areaManagerAssignments.cEmp, cEmp),
        eq(areaManagerAssignments.cArea, cArea),
        lte(areaManagerAssignments.validFrom, t),
        or(isNull(areaManagerAssignments.validTo), gte(areaManagerAssignments.validTo, t)),
      ),
    );
}

async function activeRoleRows(
  db: Runner,
  role: 'AREA_MANAGER' | 'AREA_DIRECTOR',
  cEmp: string,
  cArea: string,
) {
  const t = todayIso();
  return db
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.role, role),
        eq(roleAssignments.companyCode, cEmp),
        eq(roleAssignments.areaCode, cArea),
        lte(roleAssignments.validFrom, t),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, t)),
      ),
    );
}

/** Jefe y director vigentes del área, y las personas que se pueden designar (cuenta activa de la empresa). */
export async function getAreaApprovers(db: Db, cEmp: string, cArea: string) {
  if (!(await areaExists(db, cEmp, cArea))) throw new OrgError('AREA_NOT_FOUND');
  const [m] = await currentManagerRows(db, cEmp, cArea);
  const directors = await activeRoleRows(db, 'AREA_DIRECTOR', cEmp, cArea);
  const candidates = await db
    .select({
      accountId: accounts.id,
      nIde: accounts.nIde,
      name: employeeSnapshots.nombre,
      email: accounts.email,
    })
    .from(accounts)
    .innerJoin(
      employeeSnapshots,
      and(eq(employeeSnapshots.nIde, accounts.nIde), eq(employeeSnapshots.est, 'V')),
    )
    .where(and(eq(employeeSnapshots.cEmp, cEmp), eq(accounts.status, 'ACTIVA')))
    .orderBy(employeeSnapshots.nombre);
  return {
    manager: m ? await person(db, m.managerAccountId) : null,
    director: directors[0] ? await person(db, directors[0].accountId) : null,
    candidates,
  };
}

/**
 * Designa el jefe y/o el director de un área para las aprobaciones. Concede el rol correspondiente
 * al nuevo titular y termina el del anterior a partir de ayer, de modo que nunca haya dos vigentes.
 */
export async function setAreaApprovers(
  db: Db,
  actorId: string,
  cEmp: string,
  cArea: string,
  input: AreaApproversInput,
): Promise<void> {
  const fail = async (code: OrgError['code']): Promise<never> => {
    await db.insert(auditLogs).values({
      actorAccountId: actorId,
      action: 'AREA_APPROVERS_SET',
      resource: 'area_approvers',
      resourceId: `${cEmp}/${cArea}`,
      result: code,
    });
    throw new OrgError(code);
  };
  if (!(await hasActiveRole(db, actorId, ADMIN_ROLES))) return fail('FORBIDDEN');
  if (!(await areaExists(db, cEmp, cArea))) return fail('AREA_NOT_FOUND');
  const { managerAccountId: mgr, directorAccountId: dir } = input;
  for (const id of [mgr, dir])
    if (id) {
      if (id === actorId) return fail('SELF_GRANT');
      const [a] = await db
        .select({ status: accounts.status })
        .from(accounts)
        .where(eq(accounts.id, id));
      if (!a) return fail('ACCOUNT_NOT_FOUND');
      if (a.status !== 'ACTIVA') return fail('MANAGER_NOT_ELIGIBLE');
    }

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`area-approvers:${cEmp}:${cArea}`}))`,
    );
    const t = todayIso();
    const end = yesterdayIso();
    const curManagers = await currentManagerRows(tx as unknown as Runner, cEmp, cArea);
    const curDirectors = await activeRoleRows(
      tx as unknown as Runner,
      'AREA_DIRECTOR',
      cEmp,
      cArea,
    );
    const nextManager = mgr === undefined ? (curManagers[0]?.managerAccountId ?? null) : mgr;
    const nextDirector = dir === undefined ? (curDirectors[0]?.accountId ?? null) : dir;
    if (nextManager && nextManager === nextDirector) return 'SAME_PERSON' as const;

    const grant = async (role: 'AREA_MANAGER' | 'AREA_DIRECTOR', accountId: string) => {
      const has = (await activeRoleRows(tx as unknown as Runner, role, cEmp, cArea)).some(
        (r) => r.accountId === accountId,
      );
      if (!has)
        await tx.insert(roleAssignments).values({
          accountId,
          role,
          companyCode: cEmp,
          areaCode: cArea,
          validFrom: t,
        });
    };
    const endRoles = async (role: 'AREA_MANAGER' | 'AREA_DIRECTOR', keep: string | null) => {
      const ids = (await activeRoleRows(tx as unknown as Runner, role, cEmp, cArea))
        .filter((r) => r.accountId !== keep)
        .map((r) => r.id);
      if (ids.length)
        await tx
          .update(roleAssignments)
          .set({ validTo: end })
          .where(inArray(roleAssignments.id, ids));
    };

    if (mgr !== undefined) {
      const same = curManagers.length === 1 && curManagers[0]?.managerAccountId === mgr;
      if (!same) {
        const ids = curManagers.map((r) => r.id);
        if (ids.length)
          await tx
            .update(areaManagerAssignments)
            .set({ validTo: end })
            .where(inArray(areaManagerAssignments.id, ids));
        if (mgr) {
          await grant('AREA_MANAGER', mgr);
          await tx.insert(areaManagerAssignments).values({
            cEmp,
            cArea,
            managerAccountId: mgr,
            validFrom: t,
            createdBy: actorId,
          });
        }
      }
      await endRoles('AREA_MANAGER', mgr);
    }
    if (dir !== undefined) {
      if (dir) await grant('AREA_DIRECTOR', dir);
      await endRoles('AREA_DIRECTOR', dir);
    }
    return 'OK' as const;
  });
  if (result !== 'OK') return fail('SAME_PERSON');
  await db.insert(auditLogs).values({
    actorAccountId: actorId,
    action: 'AREA_APPROVERS_SET',
    resource: 'area_approvers',
    resourceId: `${cEmp}/${cArea}`,
    result: 'SUCCESS',
    context: { manager: mgr ?? null, director: dir ?? null },
  });
}
