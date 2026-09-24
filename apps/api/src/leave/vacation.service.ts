import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  auditLogs,
  employeeSnapshots,
  progVac,
  progVacAdjustments,
  vacaciones,
  vacationActions,
  vacationRequests,
  vacationRevisionAllocations,
  vacationRevisions,
} from '../db/schema';
import { activeCompaniesForRole, hasActiveRole } from '../auth/roles';
import { resolveAreaManager } from '../org/area-managers.service';
import { PlanError, hashPlan, planLeave, prepareCalendars, type Allocation } from './leave-plan';
import { internalState } from './prog-vac.service';

export type VacationErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SELF_APPROVAL'
  | 'INVALID_STATE'
  | 'NO_MANAGER'
  | 'OVERLAP'
  | 'REASON_REQUIRED'
  | 'CALENDAR_CHANGED'
  | 'INSUFFICIENT_DISP'
  | 'NO_ACTIVE_CONTRACT';

export class VacationError extends Error {
  constructor(
    readonly code: VacationErrorCode,
    readonly detail: unknown = undefined,
  ) {
    super(code);
  }
}

export const OPEN_STATUSES = ['PENDIENTE_JEFE', 'REVISION_EMPLEADO', 'PENDIENTE_FINAL'] as const;
const BLOCKING = [...OPEN_STATUSES, 'APROBADA'];

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Runner = Db | Tx;

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'vacation_request',
    resourceId: id,
    result,
  });
}

async function contractOf(db: Runner, accountId: string) {
  const [row] = await db
    .select({
      nIde: accounts.nIde,
      nCont: employeeSnapshots.nCont,
      cEmp: employeeSnapshots.cEmp,
      cArea: employeeSnapshots.cArea,
      nombre: employeeSnapshots.nombre,
    })
    .from(accounts)
    .innerJoin(
      employeeSnapshots,
      and(eq(employeeSnapshots.nIde, accounts.nIde), eq(employeeSnapshots.est, 'V')),
    )
    .where(eq(accounts.id, accountId));
  return row ?? null;
}

async function overlaps(
  db: Runner,
  nIde: string,
  start: string,
  end: string,
  excludeRequestId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: vacationRequests.id })
    .from(vacationRequests)
    .innerJoin(
      vacationRevisions,
      and(
        eq(vacationRevisions.requestId, vacationRequests.id),
        eq(vacationRevisions.number, vacationRequests.currentRevision),
      ),
    )
    .where(
      and(
        eq(vacationRequests.nIde, nIde),
        inArray(vacationRequests.status, BLOCKING),
        sql`${vacationRevisions.startDate} <= ${end} and ${vacationRevisions.endDate} >= ${start}`,
        excludeRequestId ? ne(vacationRequests.id, excludeRequestId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function loadRequest(db: Runner, id: string) {
  const [req] = await db.select().from(vacationRequests).where(eq(vacationRequests.id, id));
  if (!req) throw new VacationError('NOT_FOUND');
  return req;
}

async function currentRevision(db: Runner, req: { id: string; currentRevision: number }) {
  const [rev] = await db
    .select()
    .from(vacationRevisions)
    .where(
      and(
        eq(vacationRevisions.requestId, req.id),
        eq(vacationRevisions.number, req.currentRevision),
      ),
    );
  if (!rev) throw new Error('revisión vigente no encontrada');
  return rev;
}

async function record(
  db: Runner,
  requestId: string,
  revisionNumber: number,
  actor: string,
  action: string,
  contentHash: string,
  comment?: string | null,
) {
  await db.insert(vacationActions).values({
    requestId,
    revisionNumber,
    actorAccountId: actor,
    action,
    contentHash,
    comment: comment ?? null,
  });
}

async function lockRequest(tx: Tx, id: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`vacation:${id}`}))`);
}

async function insertRevision(
  tx: Tx,
  requestId: string,
  number: number,
  plan: Awaited<ReturnType<typeof planLeave>>,
  proposedBy: string,
  reason: string | null,
) {
  const [rev] = await tx
    .insert(vacationRevisions)
    .values({
      requestId,
      number,
      startDate: plan.start,
      endDate: plan.end,
      calendarDiff: plan.calendarDiff,
      businessDays: plan.businessDays,
      returnDate: plan.returnDate,
      countedDays: plan.countedDays,
      calendarIds: plan.calendarIds,
      proposedBy,
      reason,
      contentHash: plan.contentHash,
    })
    .returning({ id: vacationRevisions.id });
  if (!rev) throw new Error('revisión no creada');
  await tx
    .insert(vacationRevisionAllocations)
    .values(
      plan.allocations.map((a) => ({ revisionId: rev.id, progVacId: a.progVacId, days: a.days })),
    );
  return rev.id;
}

/** El empleado envía la solicitud y acepta con ello las fechas calculadas (revisión 1). */
export async function submitRequest(
  db: Db,
  accountId: string,
  input: { start: string; allocations: Allocation[] },
) {
  const c = await contractOf(db, accountId);
  if (!c?.cEmp || !c.cArea) throw new VacationError('NO_ACTIVE_CONTRACT');
  await prepareCalendars(db, accountId, input.start, input.allocations);
  const plan = await planLeave(db, c, input.start, input.allocations);
  const today = new Date().toISOString().slice(0, 10);
  const manager = await resolveAreaManager(db, c.cEmp, c.cArea, today);
  if (!manager) {
    await audit(db, accountId, 'VACATION_SUBMIT', null, 'NO_MANAGER');
    throw new VacationError('NO_MANAGER');
  }
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`vacation-person:${c.nIde}`}))`);
    if (await overlaps(tx, c.nIde, plan.start, plan.end)) throw new VacationError('OVERLAP');
    const [req] = await tx
      .insert(vacationRequests)
      .values({
        accountId,
        nIde: c.nIde,
        nCont: c.nCont,
        cEmp: c.cEmp ?? '',
        cArea: c.cArea ?? '',
        managerAccountId: manager,
      })
      .returning({ id: vacationRequests.id });
    if (!req) throw new Error('solicitud no creada');
    await insertRevision(tx, req.id, 1, plan, accountId, null);
    await record(tx, req.id, 1, accountId, 'ENVIAR', plan.contentHash);
    return req.id;
  });
  await audit(db, accountId, 'VACATION_SUBMIT', id, 'SUCCESS');
  return { id };
}

async function summary(db: Runner, reqs: (typeof vacationRequests.$inferSelect)[]) {
  if (reqs.length === 0) return [];
  const revs = await db
    .select()
    .from(vacationRevisions)
    .where(
      inArray(
        vacationRevisions.requestId,
        reqs.map((r) => r.id),
      ),
    );
  return reqs.map((r) => {
    const rev = revs.find((x) => x.requestId === r.id && x.number === r.currentRevision);
    return {
      id: r.id,
      status: r.status,
      nIde: r.nIde,
      revision: r.currentRevision,
      start: rev?.startDate ?? null,
      end: rev?.endDate ?? null,
      calendarDiff: rev?.calendarDiff ?? null,
      businessDays: rev?.businessDays ?? null,
      returnDate: rev?.returnDate ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function listMine(db: Db, accountId: string) {
  const reqs = await db
    .select()
    .from(vacationRequests)
    .where(eq(vacationRequests.accountId, accountId))
    .orderBy(desc(vacationRequests.createdAt))
    .limit(100);
  return summary(db, reqs);
}

export async function listAssignedToManager(db: Db, managerId: string) {
  const reqs = await db
    .select()
    .from(vacationRequests)
    .where(eq(vacationRequests.managerAccountId, managerId))
    .orderBy(desc(vacationRequests.updatedAt))
    .limit(200);
  const rows = await summary(db, reqs);
  return withNames(db, rows, reqs);
}

/** Solo las solicitudes de las empresas donde el usuario es aprobador final. */
export async function listForFinal(db: Db, actorId: string) {
  const companies = await activeCompaniesForRole(db, actorId, 'VACATION_FINAL_APPROVER');
  if (companies.length === 0) return [];
  const reqs = await db
    .select()
    .from(vacationRequests)
    .where(
      and(
        inArray(vacationRequests.status, ['PENDIENTE_FINAL', 'APROBADA', 'RECHAZADA']),
        inArray(vacationRequests.cEmp, companies),
      ),
    )
    .orderBy(desc(vacationRequests.updatedAt))
    .limit(200);
  const rows = await summary(db, reqs);
  return withNames(db, rows, reqs);
}

async function withNames(
  db: Runner,
  rows: Awaited<ReturnType<typeof summary>>,
  reqs: (typeof vacationRequests.$inferSelect)[],
) {
  const names = new Map<string, string>();
  for (const r of reqs) {
    if (names.has(r.nIde)) continue;
    const [e] = await db
      .select({ nombre: employeeSnapshots.nombre })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, r.nIde), eq(employeeSnapshots.nCont, r.nCont)));
    names.set(r.nIde, e?.nombre ?? r.nIde);
  }
  return rows.map((r) => ({ ...r, employee: names.get(r.nIde) ?? r.nIde }));
}

/** Detalle: solo el dueño, el jefe asignado o quien tenga el rol de aprobación final. */
export async function detail(db: Db, viewerId: string, id: string) {
  const req = await loadRequest(db, id);
  const isOwner = req.accountId === viewerId;
  const isManager = req.managerAccountId === viewerId;
  const canFinal =
    !isOwner &&
    !isManager &&
    (await activeCompaniesForRole(db, viewerId, 'VACATION_FINAL_APPROVER')).includes(req.cEmp);
  if (!isOwner && !isManager && !canFinal) throw new VacationError('NOT_FOUND');
  const revisions = await db
    .select()
    .from(vacationRevisions)
    .where(eq(vacationRevisions.requestId, id))
    .orderBy(vacationRevisions.number);
  const allocations = await db
    .select({
      revisionId: vacationRevisionAllocations.revisionId,
      progVacId: vacationRevisionAllocations.progVacId,
      days: vacationRevisionAllocations.days,
      perIni: progVac.perIni,
      perFin: progVac.perFin,
    })
    .from(vacationRevisionAllocations)
    .innerJoin(progVac, eq(progVac.id, vacationRevisionAllocations.progVacId))
    .where(
      inArray(
        vacationRevisionAllocations.revisionId,
        revisions.map((r) => r.id),
      ),
    );
  const actions = await db
    .select({
      revisionNumber: vacationActions.revisionNumber,
      action: vacationActions.action,
      comment: vacationActions.comment,
      at: vacationActions.at,
      actor: vacationActions.actorAccountId,
    })
    .from(vacationActions)
    .where(eq(vacationActions.requestId, id))
    .orderBy(vacationActions.at);
  const [named] = await withNames(db, await summary(db, [req]), [req]);
  return {
    ...named,
    isOwner,
    isManager,
    revisions: revisions.map((r) => ({
      number: r.number,
      start: r.startDate,
      end: r.endDate,
      calendarDiff: r.calendarDiff,
      businessDays: r.businessDays,
      returnDate: r.returnDate,
      reason: r.reason,
      proposedByMe: r.proposedBy === viewerId,
      allocations: allocations
        .filter((a) => a.revisionId === r.id)
        .map((a) => ({ progVacId: a.progVacId, days: a.days, perIni: a.perIni, perFin: a.perFin })),
    })),
    actions: actions.map((a) => ({ ...a, byMe: a.actor === viewerId, actor: undefined })),
  };
}

async function transition(
  db: Db,
  actor: string,
  id: string,
  opts: {
    from: string[];
    to: string;
    action: string;
    comment?: string | null;
    guard: (req: typeof vacationRequests.$inferSelect) => Promise<void> | void;
  },
) {
  try {
    await db.transaction(async (tx) => {
      await lockRequest(tx, id);
      const req = await loadRequest(tx, id);
      await opts.guard(req);
      if (!opts.from.includes(req.status)) throw new VacationError('INVALID_STATE');
      const rev = await currentRevision(tx, req);
      await tx
        .update(vacationRequests)
        .set({ status: opts.to, updatedAt: new Date() })
        .where(eq(vacationRequests.id, id));
      await record(tx, id, rev.number, actor, opts.action, rev.contentHash, opts.comment);
    });
  } catch (e) {
    await audit(
      db,
      actor,
      `VACATION_${opts.action}`,
      id,
      e instanceof VacationError ? e.code : 'ERROR',
    );
    throw e;
  }
  await audit(db, actor, `VACATION_${opts.action}`, id, 'SUCCESS');
}

async function asManager(db: Runner, actor: string, req: typeof vacationRequests.$inferSelect) {
  if (req.managerAccountId !== actor) throw new VacationError('NOT_FOUND');
  if (req.accountId === actor) throw new VacationError('SELF_APPROVAL');
  if (!(await hasActiveRole(db as Db, actor, ['AREA_MANAGER'])))
    throw new VacationError('FORBIDDEN');
}

const needReason = (reason: string | undefined) => {
  if (!reason || reason.trim().length < 10) throw new VacationError('REASON_REQUIRED');
  return reason.trim();
};

export function cancelRequest(db: Db, accountId: string, id: string) {
  return transition(db, accountId, id, {
    from: [...OPEN_STATUSES],
    to: 'CANCELADA',
    action: 'CANCELAR',
    guard: (req) => {
      if (req.accountId !== accountId) throw new VacationError('NOT_FOUND');
    },
  });
}

/** Aceptación por el empleado de la revisión propuesta por el jefe. */
export function acceptRevision(db: Db, accountId: string, id: string) {
  return transition(db, accountId, id, {
    from: ['REVISION_EMPLEADO'],
    to: 'PENDIENTE_FINAL',
    action: 'ACEPTAR',
    guard: (req) => {
      if (req.accountId !== accountId) throw new VacationError('NOT_FOUND');
    },
  });
}

export function managerApprove(db: Db, actor: string, id: string) {
  return transition(db, actor, id, {
    from: ['PENDIENTE_JEFE'],
    to: 'PENDIENTE_FINAL',
    action: 'APROBAR_JEFE',
    guard: (req) => asManager(db, actor, req),
  });
}

export async function managerReject(db: Db, actor: string, id: string, reason?: string) {
  const comment = needReason(reason);
  return transition(db, actor, id, {
    from: ['PENDIENTE_JEFE'],
    to: 'RECHAZADA',
    action: 'RECHAZAR',
    comment,
    guard: (req) => asManager(db, actor, req),
  });
}

/** El jefe propone otras fechas o días: revisión nueva que el empleado debe aceptar. */
export async function managerPropose(
  db: Db,
  actor: string,
  id: string,
  input: { start: string; allocations: Allocation[]; reason?: string | undefined },
) {
  const reason = needReason(input.reason);
  // Fuera de la transacción: puede consultar el servicio externo si falta el calendario de un año.
  await prepareCalendars(db, actor, input.start, input.allocations);
  try {
    await db.transaction(async (tx) => {
      await lockRequest(tx, id);
      const req = await loadRequest(tx, id);
      await asManager(tx, actor, req);
      if (req.status !== 'PENDIENTE_JEFE') throw new VacationError('INVALID_STATE');
      const plan = await planLeave(tx as unknown as Db, req, input.start, input.allocations);
      if (await overlaps(tx, req.nIde, plan.start, plan.end, req.id))
        throw new VacationError('OVERLAP');
      const number = req.currentRevision + 1;
      await insertRevision(tx, id, number, plan, actor, reason);
      await tx
        .update(vacationRequests)
        .set({ status: 'REVISION_EMPLEADO', currentRevision: number, updatedAt: new Date() })
        .where(eq(vacationRequests.id, id));
      await record(tx, id, number, actor, 'PROPONER', plan.contentHash, reason);
    });
  } catch (e) {
    await audit(db, actor, 'VACATION_PROPONER', id, errCode(e));
    throw e;
  }
  await audit(db, actor, 'VACATION_PROPONER', id, 'SUCCESS');
}

const errCode = (e: unknown) =>
  e instanceof VacationError || e instanceof PlanError ? e.code : 'ERROR';

async function asFinal(db: Runner, actor: string, req: typeof vacationRequests.$inferSelect) {
  if (req.accountId === actor) throw new VacationError('SELF_APPROVAL');
  const companies = await activeCompaniesForRole(db as Db, actor, 'VACATION_FINAL_APPROVER');
  if (companies.length === 0) throw new VacationError('FORBIDDEN');
  // Con el rol, pero de otra empresa: la solicitud no existe para él.
  if (!companies.includes(req.cEmp)) throw new VacationError('NOT_FOUND');
}

export async function finalReject(db: Db, actor: string, id: string, reason?: string) {
  const comment = needReason(reason);
  return transition(db, actor, id, {
    from: ['PENDIENTE_FINAL'],
    to: 'RECHAZADA',
    action: 'RECHAZAR',
    comment,
    guard: (req) => asFinal(db, actor, req),
  });
}

/**
 * Aprobación final: en una sola transacción revalida períodos y calendario, descuenta DISP de cada
 * período y crea VACACIONES. Dos aprobaciones concurrentes no pueden consumir más que DISP.
 */
export async function finalApprove(db: Db, actor: string, id: string) {
  try {
    await db.transaction(async (tx) => {
      await lockRequest(tx, id);
      const req = await loadRequest(tx, id);
      await asFinal(tx, actor, req);
      if (req.status !== 'PENDIENTE_FINAL') throw new VacationError('INVALID_STATE');
      const rev = await currentRevision(tx, req);
      const allocs = await tx
        .select()
        .from(vacationRevisionAllocations)
        .where(eq(vacationRevisionAllocations.revisionId, rev.id));

      // Bloquea los períodos en orden estable para evitar interbloqueos entre aprobaciones.
      const periods = await tx
        .select()
        .from(progVac)
        .where(
          inArray(
            progVac.id,
            allocs.map((a) => a.progVacId),
          ),
        )
        .orderBy(progVac.id)
        .for('update');
      for (const a of allocs) {
        const p = periods.find((x) => x.id === a.progVacId);
        if (!p || !p.active || p.disp < a.days) throw new VacationError('INSUFFICIENT_DISP');
      }
      const plan = await planLeave(
        tx as unknown as Db,
        req,
        rev.startDate,
        allocs.map((a) => ({ progVacId: a.progVacId, days: a.days })),
      );
      if (
        hashPlan(plan, plan.allocations, plan.calendarIds) !== rev.contentHash ||
        plan.end !== rev.endDate ||
        plan.returnDate !== rev.returnDate
      )
        throw new VacationError('CALENDAR_CHANGED');
      if (await overlaps(tx, req.nIde, rev.startDate, rev.endDate, req.id))
        throw new VacationError('OVERLAP');

      for (const a of allocs) {
        const p = periods.find((x) => x.id === a.progVacId);
        if (!p) continue;
        const disp = p.disp - a.days;
        const version = p.version + 1;
        await tx.insert(progVacAdjustments).values({
          progVacId: p.id,
          actorAccountId: actor,
          version,
          oldDias: p.dias,
          newDias: p.dias,
          oldDisp: p.disp,
          newDisp: disp,
          reason: `Disfrute aprobado (solicitud ${id}, revisión ${rev.number})`,
        });
        await tx
          .update(progVac)
          .set({ disp, estado: internalState(disp), version, updatedAt: new Date() })
          .where(eq(progVac.id, p.id));
      }
      await tx.insert(vacaciones).values({
        requestId: id,
        revisionId: rev.id,
        nIde: req.nIde,
        nCont: req.nCont,
        fecIniDis: rev.startDate,
        fecFinDis: rev.endDate,
        diasDis: rev.calendarDiff,
        diasHabiles: rev.businessDays,
        fechaRetorno: rev.returnDate,
      });
      await tx
        .update(vacationRequests)
        .set({ status: 'APROBADA', updatedAt: new Date() })
        .where(eq(vacationRequests.id, id));
      await record(tx, id, rev.number, actor, 'APROBAR_FINAL', rev.contentHash);
    });
  } catch (e) {
    await audit(db, actor, 'VACATION_APROBAR_FINAL', id, errCode(e));
    throw e;
  }
  await audit(db, actor, 'VACATION_APROBAR_FINAL', id, 'SUCCESS');
}

export async function listApprovedFor(db: Db, nIde: string) {
  return db
    .select()
    .from(vacaciones)
    .where(eq(vacaciones.nIde, nIde))
    .orderBy(desc(vacaciones.fecIniDis));
}
