import { and, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { activeCompaniesForRole, hasActiveRole } from '../auth/roles';
import type { Db } from '../db/client';
import {
  accounts,
  approvalSubstitutions,
  auditLogs,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { APPROVER_ROLE_NAMES } from './approver-signature.service';

export type SubstitutionErrorCode =
  | 'NOT_APPROVER'
  | 'INVALID_DATES'
  | 'PAST_START'
  | 'TOO_LONG'
  | 'SELF'
  | 'SUBSTITUTE_NOT_ELIGIBLE'
  | 'NO_COMMON_COMPANY'
  | 'OVERLAP'
  | 'CHAIN'
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'REASON_REQUIRED';

export class SubstitutionError extends Error {
  constructor(readonly code: SubstitutionErrorCode) {
    super(code);
  }
}

/** Tope de una suplencia, en días (el día inicial y el final cuentan). */
export const MAX_SUBSTITUTION_DAYS = 90;
const DAY = 86_400_000;

type Sub = typeof approvalSubstitutions.$inferSelect;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const spanDays = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;

async function audit(
  db: Db,
  actor: string,
  action: string,
  id: string | null,
  result: string,
  context: object = {},
) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'approval_substitution',
    resourceId: id,
    result,
    context,
  });
}

const activeOn = (date: string) =>
  and(
    eq(approvalSubstitutions.status, 'ACTIVA'),
    lte(approvalSubstitutions.validFrom, date),
    gte(approvalSubstitutions.validTo, date),
  );

// ---------- consultas de autoridad (las usan vacaciones, permisos, bandeja y avisos) ----------

/** Suplencias en las que esta persona es hoy el suplente. */
export async function activeAsSubstitute(
  db: Db,
  accountId: string,
  date = today(),
): Promise<Sub[]> {
  return db
    .select()
    .from(approvalSubstitutions)
    .where(and(eq(approvalSubstitutions.substituteAccountId, accountId), activeOn(date)));
}

/** La suplencia vigente de un titular (durante ella, el titular no decide). */
export async function activeAsTitular(
  db: Db,
  titularId: string,
  date = today(),
): Promise<Sub | null> {
  const [s] = await db
    .select()
    .from(approvalSubstitutions)
    .where(and(eq(approvalSubstitutions.titularAccountId, titularId), activeOn(date)))
    .limit(1);
  return s ?? null;
}

/** ¿Hoy suple a alguien? Basta para entrar a las pantallas de aprobación (el detalle lo decide el servicio). */
export async function isSubstituteNow(db: Db, accountId: string): Promise<boolean> {
  return (await activeAsSubstitute(db, accountId)).length > 0;
}

/**
 * Titulares cuyas asignaciones puede decidir esta persona: ella misma (salvo que esté en suplencia) y
 * aquellos a quienes suple hoy.
 */
export async function approverIdsFor(db: Db, actorId: string, date = today()): Promise<string[]> {
  const ids: string[] = [];
  if (!(await activeAsTitular(db, actorId, date))) ids.push(actorId);
  for (const s of await activeAsSubstitute(db, actorId, date)) ids.push(s.titularAccountId);
  return ids;
}

/**
 * ¿Puede `actor` decidir lo asignado a `assignedId`? Sí si es esa persona y no está en suplencia, o si la
 * suple hoy. `onBehalfOf` dice a quién suple (nulo si actúa por sí mismo).
 */
export async function canActFor(
  db: Db,
  actor: string,
  assignedId: string,
  date = today(),
): Promise<{ allowed: boolean; onBehalfOf: string | null }> {
  if (actor === assignedId) {
    return { allowed: !(await activeAsTitular(db, actor, date)), onBehalfOf: null };
  }
  const subs = await activeAsSubstitute(db, actor, date);
  const covers = subs.some((s) => s.titularAccountId === assignedId);
  return { allowed: covers, onBehalfOf: covers ? assignedId : null };
}

/**
 * Empresas donde esta persona puede dar la aprobación final: las de su rol (salvo que esté en suplencia)
 * más las del titular a quien suple. `viaTitular` dice, por empresa, a quién suple cuando no es por rol propio.
 */
export async function finalCompaniesFor(db: Db, actor: string, date = today()) {
  const companies = new Set<string>();
  const viaTitular = new Map<string, string>();
  if (!(await activeAsTitular(db, actor, date)))
    for (const c of await activeCompaniesForRole(db, actor, 'VACATION_FINAL_APPROVER'))
      companies.add(c);
  for (const s of await activeAsSubstitute(db, actor, date))
    for (const c of await activeCompaniesForRole(db, s.titularAccountId, 'VACATION_FINAL_APPROVER'))
      if (!companies.has(c)) {
        companies.add(c);
        viaTitular.set(c, s.titularAccountId);
      }
  return { companies: [...companies], viaTitular };
}

/** A quién se avisa de lo asignado a un titular: a su suplente si está en suplencia, si no a él. */
export async function effectiveRecipient(db: Db, titularId: string, date = today()) {
  return (await activeAsTitular(db, titularId, date))?.substituteAccountId ?? titularId;
}

// ---------- gestión ----------

/** Empresas donde la cuenta tiene hoy un rol que aprueba. */
async function approverCompanies(db: Db, accountId: string): Promise<Set<string>> {
  const t = today();
  const rows = await db
    .select({ c: roleAssignments.companyCode })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        inArray(roleAssignments.role, [...APPROVER_ROLE_NAMES]),
        lte(roleAssignments.validFrom, t),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, t)),
      ),
    );
  return new Set(rows.flatMap((r) => (r.c ? [r.c] : [])));
}

async function personName(db: Db, nIde: string): Promise<string> {
  const [e] = await db
    .select({ nombre: employeeSnapshots.nombre })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, nIde))
    .orderBy(sql`case when ${employeeSnapshots.est} = 'V' then 0 else 1 end`)
    .limit(1);
  return e?.nombre ?? nIde;
}

/** Personas que pueden suplir a esta: cuenta activa, empleado vigente y un rol que aprueba en una empresa común. */
export async function substituteCandidates(db: Db, titularId: string) {
  const mine = await approverCompanies(db, titularId);
  if (mine.size === 0) return [];
  const t = today();
  const rows = await db
    .selectDistinct({ id: accounts.id, nIde: accounts.nIde, email: accounts.email })
    .from(roleAssignments)
    .innerJoin(accounts, eq(accounts.id, roleAssignments.accountId))
    .innerJoin(
      employeeSnapshots,
      and(eq(employeeSnapshots.nIde, accounts.nIde), eq(employeeSnapshots.est, 'V')),
    )
    .where(
      and(
        ne(accounts.id, titularId),
        eq(accounts.status, 'ACTIVA'),
        inArray(roleAssignments.role, [...APPROVER_ROLE_NAMES]),
        inArray(roleAssignments.companyCode, [...mine]),
        lte(roleAssignments.validFrom, t),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, t)),
      ),
    );
  const out = [];
  for (const r of rows) out.push({ id: r.id, name: await personName(db, r.nIde) });
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export interface CreateSubstitution {
  substituteAccountId: string;
  validFrom: string;
  validTo: string;
}

/** El titular designa a su suplente para un rango de fechas. */
export async function createSubstitution(db: Db, titularId: string, input: CreateSubstitution) {
  const fail = async (code: SubstitutionErrorCode): Promise<never> => {
    await audit(db, titularId, 'SUBSTITUTION_CREATE', null, code, {
      substitute: input.substituteAccountId,
    });
    throw new SubstitutionError(code);
  };
  if (!(await hasActiveRole(db, titularId, APPROVER_ROLE_NAMES))) return fail('NOT_APPROVER');
  if (input.substituteAccountId === titularId) return fail('SELF');
  if (!isDate(input.validFrom) || !isDate(input.validTo) || input.validTo < input.validFrom)
    return fail('INVALID_DATES');
  if (input.validFrom < today()) return fail('PAST_START');
  if (spanDays(input.validFrom, input.validTo) > MAX_SUBSTITUTION_DAYS) return fail('TOO_LONG');

  const eligible = (await substituteCandidates(db, titularId)).some(
    (c) => c.id === input.substituteAccountId,
  );
  if (!eligible) {
    // distingue «no tiene rol de aprobación» de «es de otra empresa» para el mensaje
    const [acc] = await db
      .select({ status: accounts.status })
      .from(accounts)
      .where(eq(accounts.id, input.substituteAccountId));
    const theirs =
      acc?.status === 'ACTIVA'
        ? await approverCompanies(db, input.substituteAccountId)
        : new Set<string>();
    if (theirs.size > 0) return fail('NO_COMMON_COMPANY');
    return fail('SUBSTITUTE_NOT_ELIGIBLE');
  }

  const id = await db
    .transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`substitution:${titularId}`})), pg_advisory_xact_lock(hashtext(${`substitution:${input.substituteAccountId}`}))`,
      );
      const overlapping = (
        col:
          | typeof approvalSubstitutions.titularAccountId
          | typeof approvalSubstitutions.substituteAccountId,
        who: string,
      ) =>
        tx
          .select({ id: approvalSubstitutions.id })
          .from(approvalSubstitutions)
          .where(
            and(
              eq(col, who),
              eq(approvalSubstitutions.status, 'ACTIVA'),
              lte(approvalSubstitutions.validFrom, input.validTo),
              gte(approvalSubstitutions.validTo, input.validFrom),
            ),
          )
          .limit(1);
      // un titular no tiene dos suplencias a la vez
      if ((await overlapping(approvalSubstitutions.titularAccountId, titularId)).length > 0)
        throw new SubstitutionError('OVERLAP');
      // sin cadenas: ni el suplente está a su vez suplido, ni el titular suple a otro en esas fechas
      if (
        (await overlapping(approvalSubstitutions.titularAccountId, input.substituteAccountId))
          .length > 0 ||
        (await overlapping(approvalSubstitutions.substituteAccountId, titularId)).length > 0
      )
        throw new SubstitutionError('CHAIN');
      const [row] = await tx
        .insert(approvalSubstitutions)
        .values({
          titularAccountId: titularId,
          substituteAccountId: input.substituteAccountId,
          validFrom: input.validFrom,
          validTo: input.validTo,
        })
        .returning({ id: approvalSubstitutions.id });
      if (!row) throw new Error('suplencia no creada');
      return row.id;
    })
    .catch(async (e: unknown) => {
      if (e instanceof SubstitutionError) return fail(e.code);
      throw e;
    });
  await audit(db, titularId, 'SUBSTITUTION_CREATE', id, 'SUCCESS', {
    substitute: input.substituteAccountId,
    from: input.validFrom,
    to: input.validTo,
  });
  return { id };
}

async function describe(db: Db, rows: Sub[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.titularAccountId, r.substituteAccountId]))];
  const accs = ids.length
    ? await db
        .select({ id: accounts.id, nIde: accounts.nIde })
        .from(accounts)
        .where(inArray(accounts.id, ids))
    : [];
  const names = new Map<string, string>();
  for (const a of accs) names.set(a.id, await personName(db, a.nIde));
  const t = today();
  return rows.map((r) => ({
    id: r.id,
    titularAccountId: r.titularAccountId,
    titular: names.get(r.titularAccountId) ?? '',
    substituteAccountId: r.substituteAccountId,
    substitute: names.get(r.substituteAccountId) ?? '',
    validFrom: r.validFrom,
    validTo: r.validTo,
    status: r.status,
    /** Hoy rige, ya pasó o aún no empieza (solo tiene sentido si está ACTIVA). */
    phase:
      r.status !== 'ACTIVA'
        ? r.status
        : r.validTo < t
          ? 'VENCIDA'
          : r.validFrom > t
            ? 'PROGRAMADA'
            : 'VIGENTE',
    endedAt: r.endedAt,
    endReason: r.endReason,
  }));
}

/** Lo de la persona: las suplencias que ha designado y aquellas en que ella suple. */
export async function mySubstitutions(db: Db, accountId: string) {
  const eligible = await hasActiveRole(db, accountId, APPROVER_ROLE_NAMES);
  const asTitular = await db
    .select()
    .from(approvalSubstitutions)
    .where(eq(approvalSubstitutions.titularAccountId, accountId))
    .orderBy(desc(approvalSubstitutions.validFrom))
    .limit(50);
  const asSubstitute = await db
    .select()
    .from(approvalSubstitutions)
    .where(eq(approvalSubstitutions.substituteAccountId, accountId))
    .orderBy(desc(approvalSubstitutions.validFrom))
    .limit(50);
  return {
    eligible,
    maxDays: MAX_SUBSTITUTION_DAYS,
    asTitular: await describe(db, asTitular),
    asSubstitute: await describe(db, asSubstitute),
  };
}

/** El titular da por terminada su suplencia antes de tiempo. */
export async function endSubstitution(db: Db, titularId: string, id: string) {
  const [s] = await db.select().from(approvalSubstitutions).where(eq(approvalSubstitutions.id, id));
  if (!s || s.titularAccountId !== titularId) throw new SubstitutionError('NOT_FOUND');
  if (s.status !== 'ACTIVA') throw new SubstitutionError('NOT_ACTIVE');
  await db
    .update(approvalSubstitutions)
    .set({ status: 'TERMINADA', endedAt: new Date(), endedBy: titularId })
    .where(eq(approvalSubstitutions.id, id));
  await audit(db, titularId, 'SUBSTITUTION_END', id, 'SUCCESS');
}

/** Gestión Humana anula una suplencia, con motivo. */
export async function annulSubstitution(db: Db, adminId: string, id: string, reason: string) {
  if (reason.trim().length < 10) throw new SubstitutionError('REASON_REQUIRED');
  const [s] = await db.select().from(approvalSubstitutions).where(eq(approvalSubstitutions.id, id));
  if (!s) throw new SubstitutionError('NOT_FOUND');
  if (s.status !== 'ACTIVA') throw new SubstitutionError('NOT_ACTIVE');
  await db
    .update(approvalSubstitutions)
    .set({ status: 'ANULADA', endedAt: new Date(), endedBy: adminId, endReason: reason.trim() })
    .where(eq(approvalSubstitutions.id, id));
  await audit(db, adminId, 'SUBSTITUTION_ANNUL', id, 'SUCCESS', { reason: reason.trim() });
}

export interface SubstitutionQuery {
  status?: 'ACTIVA' | 'TERMINADA' | 'ANULADA' | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

/** Para Gestión Humana: todas las suplencias, con filtro por estado y por persona. */
export async function adminSubstitutions(db: Db, q: SubstitutionQuery) {
  const filters = [];
  if (q.status) filters.push(eq(approvalSubstitutions.status, q.status));
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const ids = await db
      .selectDistinct({ id: accounts.id })
      .from(accounts)
      .innerJoin(employeeSnapshots, eq(employeeSnapshots.nIde, accounts.nIde))
      .where(or(ilike(employeeSnapshots.nombre, like), ilike(accounts.nIde, like)));
    const list = ids.map((r) => r.id);
    filters.push(
      list.length === 0
        ? sql`false`
        : or(
            inArray(approvalSubstitutions.titularAccountId, list),
            inArray(approvalSubstitutions.substituteAccountId, list),
          ),
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(approvalSubstitutions)
    .where(where);
  const rows = await db
    .select()
    .from(approvalSubstitutions)
    .where(where)
    .orderBy(desc(approvalSubstitutions.validFrom), desc(approvalSubstitutions.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { total, page: q.page, pageSize: q.pageSize, items: await describe(db, rows) };
}
