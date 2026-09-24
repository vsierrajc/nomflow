import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { progVac } from '../db/schema';
import {
  LeaveCalcError,
  computeLeave,
  isValidIsoDate,
  yearsNeeded,
  type LeaveDates,
} from './business-days';
import { publishedHolidays } from './holidays.service';

export type PlanErrorCode =
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'EXCEEDS_DISP'
  | 'CALENDAR_MISSING'
  | 'START_NOT_BUSINESS_DAY'
  | 'INVALID_DAYS'
  | 'INVALID_DATE';

export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    readonly years: number[] = [],
  ) {
    super(code);
  }
}

export interface Allocation {
  progVacId: string;
  days: number;
}

export interface LeavePlan extends LeaveDates {
  calendarIds: string[];
  allocations: Allocation[];
  contentHash: string;
}

export const hashPlan = (
  p: Pick<LeaveDates, 'start' | 'end' | 'calendarDiff' | 'businessDays' | 'returnDate'>,
  allocations: Allocation[],
  calendarIds: string[],
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        s: p.start,
        e: p.end,
        c: p.calendarDiff,
        b: p.businessDays,
        r: p.returnDate,
        a: [...allocations].sort((x, y) => x.progVacId.localeCompare(y.progVacId)),
        k: [...calendarIds].sort(),
      }),
    )
    .digest('hex');

/**
 * Regla única de cálculo (vista previa, envío, propuesta del jefe y aprobación final): períodos
 * propios del contrato, 0 < días <= DISP y calendario publicado que cubra el intervalo y el retorno.
 */
export async function planLeave(
  db: Db,
  contract: { nIde: string; nCont: string },
  start: string,
  allocations: Allocation[],
): Promise<LeavePlan> {
  if (!isValidIsoDate(start)) throw new PlanError('INVALID_DATE');
  const ids = allocations.map((a) => a.progVacId);
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new PlanError('DUPLICATE');
  const rows = await db
    .select()
    .from(progVac)
    .where(
      and(
        inArray(progVac.id, ids),
        eq(progVac.nIde, contract.nIde),
        eq(progVac.nCont, contract.nCont),
        eq(progVac.active, true),
      ),
    );
  if (rows.length !== ids.length) throw new PlanError('NOT_FOUND');
  for (const a of allocations) {
    const r = rows.find((x) => x.id === a.progVacId);
    if (!r || !Number.isInteger(a.days) || a.days < 1) throw new PlanError('INVALID_DAYS');
    if (a.days > r.disp) throw new PlanError('EXCEEDS_DISP');
  }
  const total = allocations.reduce((sum, a) => sum + a.days, 0);
  let years: number[];
  try {
    years = yearsNeeded(start, total);
  } catch {
    throw new PlanError('INVALID_DATE');
  }
  const cal = await publishedHolidays(db, years);
  if (cal.missingYears.length > 0) throw new PlanError('CALENDAR_MISSING', cal.missingYears);
  try {
    const dates = computeLeave(start, total, cal.set);
    return {
      ...dates,
      calendarIds: cal.calendarIds,
      allocations,
      contentHash: hashPlan(dates, allocations, cal.calendarIds),
    };
  } catch (e) {
    if (e instanceof LeaveCalcError) throw new PlanError(e.code);
    throw e;
  }
}
