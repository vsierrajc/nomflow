import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, auditLogs, employeeSnapshots, progVac, progVacAdjustments } from '../db/schema';
import { isValidIsoDate } from './business-days';

export const MAX_DIAS = 15;

export type ProgVacErrorCode = 'INVALID_DATA' | 'NOT_FOUND' | 'DUPLICATE' | 'UNKNOWN_EMPLOYEE';

export class ProgVacError extends Error {
  constructor(readonly code: ProgVacErrorCode) {
    super(code);
  }
}

export interface ProgVacInput {
  nIde: string;
  nCont: string;
  perIni: string;
  perFin: string;
  dias: number;
  disp: number;
  estOrigen?: string | null | undefined;
  fechaCorte?: string | null | undefined;
}

export const internalState = (disp: number) => (disp === 0 ? 'LIQUIDADA' : 'ACTIVA');

/** 0 <= DISP <= DIAS <= 15 y período con fechas coherentes. */
export function validPeriod(i: Pick<ProgVacInput, 'perIni' | 'perFin' | 'dias' | 'disp'>): boolean {
  return (
    isValidIsoDate(i.perIni) &&
    isValidIsoDate(i.perFin) &&
    i.perIni <= i.perFin &&
    Number.isInteger(i.dias) &&
    Number.isInteger(i.disp) &&
    i.disp >= 0 &&
    i.disp <= i.dias &&
    i.dias <= MAX_DIAS
  );
}

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'prog_vac', resourceId: id, result });
}

export async function createPeriod(db: Db, actor: string, input: ProgVacInput) {
  if (!validPeriod(input) || !input.nIde.trim() || !input.nCont.trim()) {
    await audit(db, actor, 'PROG_VAC_CREATE', null, 'INVALID_DATA');
    throw new ProgVacError('INVALID_DATA');
  }
  // Registro manual: solo empleados activos (EST = V) y con el contrato vigente de esa persona.
  const [emp] = await db
    .select({ id: employeeSnapshots.id })
    .from(employeeSnapshots)
    .where(
      and(
        eq(employeeSnapshots.nIde, input.nIde),
        eq(employeeSnapshots.nCont, input.nCont),
        eq(employeeSnapshots.est, 'V'),
      ),
    );
  if (!emp) {
    await audit(db, actor, 'PROG_VAC_CREATE', null, 'UNKNOWN_EMPLOYEE');
    throw new ProgVacError('UNKNOWN_EMPLOYEE');
  }
  try {
    const [row] = await db
      .insert(progVac)
      .values({
        nIde: input.nIde,
        nCont: input.nCont,
        perIni: input.perIni,
        perFin: input.perFin,
        dias: input.dias,
        disp: input.disp,
        estOrigen: input.estOrigen ?? null,
        estado: internalState(input.disp),
        fechaCorte: input.fechaCorte ?? null,
        source: 'MANUAL',
        createdBy: actor,
      })
      .returning({ id: progVac.id });
    await audit(db, actor, 'PROG_VAC_CREATE', row?.id ?? null, 'SUCCESS');
    return row;
  } catch (e) {
    const pg = e as { code?: string; cause?: { code?: string } };
    if (pg.code === '23505' || pg.cause?.code === '23505') {
      await audit(db, actor, 'PROG_VAC_CREATE', null, 'DUPLICATE');
      throw new ProgVacError('DUPLICATE');
    }
    throw e;
  }
}

/** Corrige DIAS/DISP con motivo: sube la versión y deja el ajuste trazable. */
export async function adjustPeriod(
  db: Db,
  actor: string,
  id: string,
  change: { dias: number; disp: number; reason: string },
) {
  if (
    !validPeriod({ perIni: '2000-01-01', perFin: '2000-01-01', ...change }) ||
    change.reason.trim().length < 10
  ) {
    await audit(db, actor, 'PROG_VAC_ADJUST', id, 'INVALID_DATA');
    throw new ProgVacError('INVALID_DATA');
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prog-vac:${id}`}))`);
    const [cur] = await tx.select().from(progVac).where(eq(progVac.id, id));
    if (!cur || !cur.active) throw new ProgVacError('NOT_FOUND');
    const version = cur.version + 1;
    await tx.insert(progVacAdjustments).values({
      progVacId: id,
      actorAccountId: actor,
      version,
      oldDias: cur.dias,
      newDias: change.dias,
      oldDisp: cur.disp,
      newDisp: change.disp,
      reason: change.reason.trim(),
    });
    await tx
      .update(progVac)
      .set({
        dias: change.dias,
        disp: change.disp,
        estado: internalState(change.disp),
        version,
        updatedAt: new Date(),
      })
      .where(eq(progVac.id, id));
  });
  await audit(db, actor, 'PROG_VAC_ADJUST', id, 'SUCCESS');
}

/** Baja lógica; las solicitudes futuras impedirán borrar períodos con disfrutes (corrección compensatoria). */
export async function deactivatePeriod(db: Db, actor: string, id: string) {
  const res = await db
    .update(progVac)
    .set({ active: false, updatedAt: new Date() })
    .where(and(eq(progVac.id, id), eq(progVac.active, true)))
    .returning({ id: progVac.id });
  if (res.length === 0) throw new ProgVacError('NOT_FOUND');
  await audit(db, actor, 'PROG_VAC_DEACTIVATE', id, 'SUCCESS');
}

export interface PeriodListQuery {
  /** Nombre o cédula, coincidencia parcial. */
  q?: string | undefined;
  estado?: 'ACTIVA' | 'LIQUIDADA' | 'VENCIDA' | undefined;
  cEmp?: string | undefined;
  page: number;
  pageSize: number;
}

/** Empresas con al menos un período vigente, para el selector de la lista de administración. */
export async function periodCompanies(db: Db) {
  const rows = await db
    .selectDistinct({ cEmp: employeeSnapshots.cEmp })
    .from(progVac)
    .innerJoin(employeeSnapshots, eq(employeeSnapshots.nIde, progVac.nIde))
    .where(and(eq(progVac.active, true), eq(employeeSnapshots.est, 'V')));
  return rows
    .map((r) => r.cEmp)
    .filter((c): c is string => c !== null)
    .sort();
}

export async function listPeriods(db: Db, query: PeriodListQuery) {
  const vigente = db
    .select({
      nIde: employeeSnapshots.nIde,
      nombre: employeeSnapshots.nombre,
      cEmp: employeeSnapshots.cEmp,
    })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.est, 'V'))
    .as('vigente');

  const filters = [eq(progVac.active, true)];
  if (query.estado) filters.push(eq(progVac.estado, query.estado));
  if (query.cEmp) filters.push(eq(vigente.cEmp, query.cEmp));
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const cond = or(ilike(progVac.nIde, like), ilike(vigente.nombre, like));
    if (cond) filters.push(cond);
  }
  const where = and(...filters);

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(progVac)
    .leftJoin(vigente, eq(vigente.nIde, progVac.nIde))
    .where(where);
  const items = await db
    .select({
      id: progVac.id,
      nIde: progVac.nIde,
      nombre: vigente.nombre,
      nCont: progVac.nCont,
      perIni: progVac.perIni,
      perFin: progVac.perFin,
      dias: progVac.dias,
      disp: progVac.disp,
      estado: progVac.estado,
      estOrigen: progVac.estOrigen,
      version: progVac.version,
    })
    .from(progVac)
    .leftJoin(vigente, eq(vigente.nIde, progVac.nIde))
    .where(where)
    .orderBy(asc(progVac.nIde), desc(progVac.perIni))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { total: Number(total), page: query.page, pageSize: query.pageSize, items };
}

export async function listAdjustments(db: Db, id: string) {
  return db
    .select()
    .from(progVacAdjustments)
    .where(eq(progVacAdjustments.progVacId, id))
    .orderBy(desc(progVacAdjustments.at));
}

/** Contrato vigente del empleado de la cuenta (N_CONT) o null. */
export async function activeContract(db: Db, accountId: string) {
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

/** Períodos con DISP > 0 del contrato vigente del propio empleado. */
export async function myOpenPeriods(db: Db, accountId: string) {
  const c = await activeContract(db, accountId);
  if (!c) return [];
  return db
    .select({
      id: progVac.id,
      perIni: progVac.perIni,
      perFin: progVac.perFin,
      dias: progVac.dias,
      disp: progVac.disp,
    })
    .from(progVac)
    .where(
      and(
        eq(progVac.nIde, c.nIde),
        eq(progVac.nCont, c.nCont),
        eq(progVac.active, true),
        sql`${progVac.disp} > 0`,
      ),
    )
    .orderBy(asc(progVac.perIni));
}

/** Empleados activos para elegir al registrar un período a mano; N_CONT es el contrato vigente. */
export async function activeEmployees(db: Db, q?: string) {
  const like = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  return db
    .select({
      nIde: employeeSnapshots.nIde,
      nCont: employeeSnapshots.nCont,
      nombre: employeeSnapshots.nombre,
    })
    .from(employeeSnapshots)
    .where(
      and(
        eq(employeeSnapshots.est, 'V'),
        like
          ? or(ilike(employeeSnapshots.nIde, like), ilike(employeeSnapshots.nombre, like))
          : undefined,
      ),
    )
    .orderBy(asc(employeeSnapshots.nombre), asc(employeeSnapshots.nIde))
    .limit(1000);
}
