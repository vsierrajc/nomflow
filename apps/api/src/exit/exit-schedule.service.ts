import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, employeeExitSchedules, employeeSnapshots } from '../db/schema';

export type ExitScheduleErrorCode =
  | 'EMPLOYEE_NOT_FOUND'
  | 'EMPLOYEE_NOT_ACTIVE'
  | 'ALREADY_ACTIVE'
  | 'INVALID_DATE'
  | 'NOT_FOUND'
  | 'NOT_CANCELLABLE';

export class ExitScheduleError extends Error {
  constructor(readonly code: ExitScheduleErrorCode) {
    super(code);
  }
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'employee_exit_schedule',
    resourceId,
    result,
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function scheduleExit(
  db: Db,
  actorId: string,
  input: { nIde: string; plannedDate: string; reason: string },
) {
  const reason = input.reason.trim();
  if (!DATE_RE.test(input.plannedDate) || reason.length < 10 || reason.length > 500) {
    await audit(db, actorId, 'EXIT_SCHEDULE_CREATE', null, 'INVALID_INPUT');
    throw new ExitScheduleError('INVALID_DATE');
  }
  const [employee] = await db
    .select()
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, input.nIde))
    .orderBy(desc(employeeSnapshots.updatedAt))
    .limit(1);
  if (!employee) {
    await audit(db, actorId, 'EXIT_SCHEDULE_CREATE', null, 'EMPLOYEE_NOT_FOUND');
    throw new ExitScheduleError('EMPLOYEE_NOT_FOUND');
  }
  if (employee.est !== 'V') {
    await audit(db, actorId, 'EXIT_SCHEDULE_CREATE', employee.id, 'EMPLOYEE_NOT_ACTIVE');
    throw new ExitScheduleError('EMPLOYEE_NOT_ACTIVE');
  }
  try {
    const [row] = await db
      .insert(employeeExitSchedules)
      .values({
        nIde: input.nIde,
        employeeId: employee.id,
        plannedDate: input.plannedDate,
        reason,
        scheduledBy: actorId,
      })
      .returning();
    await audit(db, actorId, 'EXIT_SCHEDULE_CREATE', row?.id ?? null, 'SUCCESS');
    return row;
  } catch {
    await audit(db, actorId, 'EXIT_SCHEDULE_CREATE', null, 'ALREADY_ACTIVE');
    throw new ExitScheduleError('ALREADY_ACTIVE');
  }
}

export async function cancelExit(db: Db, actorId: string, id: string, reason: string) {
  const [current] = await db
    .select()
    .from(employeeExitSchedules)
    .where(eq(employeeExitSchedules.id, id));
  if (!current) throw new ExitScheduleError('NOT_FOUND');
  if (!['PENDIENTE', 'AVISADO'].includes(current.status)) {
    await audit(db, actorId, 'EXIT_SCHEDULE_CANCEL', id, 'NOT_CANCELLABLE');
    throw new ExitScheduleError('NOT_CANCELLABLE');
  }
  const [row] = await db
    .update(employeeExitSchedules)
    .set({
      status: 'CANCELADO',
      cancelledAt: new Date(),
      updatedAt: new Date(),
      reason: `${current.reason} | Cancelada: ${reason}`.slice(0, 500),
    })
    .where(eq(employeeExitSchedules.id, id))
    .returning();
  await audit(db, actorId, 'EXIT_SCHEDULE_CANCEL', id, 'SUCCESS');
  return row;
}

export async function listSchedules(db: Db, nIde?: string) {
  return db
    .select()
    .from(employeeExitSchedules)
    .where(nIde ? eq(employeeExitSchedules.nIde, nIde) : undefined)
    .orderBy(desc(employeeExitSchedules.scheduledAt));
}

export async function getSchedule(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(employeeExitSchedules)
    .where(eq(employeeExitSchedules.id, id));
  return row ?? null;
}

/** Bajas en PENDIENTE/AVISADO para uno o varios N_IDE (usado por la verificación de incumplimiento). */
export async function activeSchedulesForNIde(db: Db, nIdes: string[]) {
  if (nIdes.length === 0) return [];
  return db
    .select()
    .from(employeeExitSchedules)
    .where(
      and(
        inArray(employeeExitSchedules.nIde, nIdes),
        inArray(employeeExitSchedules.status, ['PENDIENTE', 'AVISADO']),
      ),
    );
}
