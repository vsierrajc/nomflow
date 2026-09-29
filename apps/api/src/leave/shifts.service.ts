import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, employeeSnapshots, shifts } from '../db/schema';

export type ShiftErrorCode = 'NOT_FOUND' | 'EXISTS' | 'VERSION_CONFLICT' | 'INVALID_SHIFT';

export class ShiftError extends Error {
  constructor(readonly code: ShiftErrorCode) {
    super(code);
  }
}

export interface ShiftInput {
  code: string;
  name: string;
  description?: string | null | undefined;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  active: boolean;
}

const WEEKDAY_COLS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const validShift = (i: ShiftInput) =>
  /^[A-Za-z0-9_-]{1,30}$/.test(i.code) &&
  i.name.trim().length > 0 &&
  i.name.length <= 100 &&
  WEEKDAY_COLS.some((d) => i[d]);

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'shift', resourceId: id, result });
}

export interface ResolvedShift {
  code: string;
  workDays: Set<number>;
}

/**
 * Resuelve el turno del contrato contra el catálogo de turnos. Devuelve null si el empleado no
 * tiene turno asignado o el código no existe/está inactivo: nunca asume lunes a viernes por
 * omisión, quien llama decide si bloquea (igual que el calendario de festivos faltante).
 */
export async function resolveShift(
  db: Db,
  nIde: string,
  nCont: string,
): Promise<ResolvedShift | null> {
  const [emp] = await db
    .select({ turno: employeeSnapshots.turno })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, nIde), eq(employeeSnapshots.nCont, nCont)));
  const code = emp?.turno?.trim();
  if (!code) return null;

  const [row] = await db
    .select()
    .from(shifts)
    .where(and(eq(shifts.code, code), eq(shifts.active, true)));
  if (!row) return null;

  const workDays = new Set<number>();
  WEEKDAY_COLS.forEach((col, idx) => {
    if (row[col]) workDays.add(idx);
  });
  return { code, workDays };
}

export async function listShifts(db: Db, onlyActive: boolean) {
  return db
    .select()
    .from(shifts)
    .where(onlyActive ? eq(shifts.active, true) : undefined)
    .orderBy(shifts.code);
}

export async function createShift(db: Db, actor: string, input: ShiftInput) {
  const data = { ...input, code: input.code.trim() };
  if (!validShift(data)) {
    await audit(db, actor, 'SHIFT_CREATE', null, 'INVALID_SHIFT');
    throw new ShiftError('INVALID_SHIFT');
  }
  const rows = await db
    .insert(shifts)
    .values({
      code: data.code,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      monday: data.monday,
      tuesday: data.tuesday,
      wednesday: data.wednesday,
      thursday: data.thursday,
      friday: data.friday,
      saturday: data.saturday,
      sunday: data.sunday,
      active: data.active,
    })
    .onConflictDoNothing()
    .returning();
  const row = rows[0];
  if (!row) {
    await audit(db, actor, 'SHIFT_CREATE', null, 'EXISTS');
    throw new ShiftError('EXISTS');
  }
  await audit(db, actor, 'SHIFT_CREATE', row.id, 'SUCCESS');
  return row;
}

/** El código no cambia; el resto sí, con control de versión. */
export async function updateShift(
  db: Db,
  actor: string,
  id: string,
  input: Omit<ShiftInput, 'code'> & { version: number },
) {
  if (!validShift({ ...input, code: 'X' })) {
    await audit(db, actor, 'SHIFT_UPDATE', id, 'INVALID_SHIFT');
    throw new ShiftError('INVALID_SHIFT');
  }
  const rows = await db
    .update(shifts)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      monday: input.monday,
      tuesday: input.tuesday,
      wednesday: input.wednesday,
      thursday: input.thursday,
      friday: input.friday,
      saturday: input.saturday,
      sunday: input.sunday,
      active: input.active,
      version: input.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(shifts.id, id), eq(shifts.version, input.version)))
    .returning();
  if (rows.length === 0) {
    const [exists] = await db.select({ id: shifts.id }).from(shifts).where(eq(shifts.id, id));
    const code = exists ? 'VERSION_CONFLICT' : 'NOT_FOUND';
    await audit(db, actor, 'SHIFT_UPDATE', id, code);
    throw new ShiftError(code);
  }
  await audit(db, actor, 'SHIFT_UPDATE', id, 'SUCCESS');
  return rows[0];
}
