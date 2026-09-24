import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, holidayCalendars, holidays } from '../db/schema';
import { isValidIsoDate } from './business-days';

export const REGION = 'CO';

export type HolidayErrorCode = 'INVALID_DATA' | 'NOT_FOUND' | 'NOT_DRAFT' | 'EMPTY';

export class HolidayError extends Error {
  constructor(readonly code: HolidayErrorCode) {
    super(code);
  }
}

export interface HolidayInput {
  date: string;
  name: string;
}

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'holiday_calendar',
    resourceId: id,
    result,
  });
}

/** Crea una versión en borrador del calendario del año; no afecta la publicada. */
export async function createDraft(
  db: Db,
  actor: string,
  year: number,
  items: HolidayInput[],
  source: 'MANUAL' | 'EXCEL' | 'API',
  reason: string,
): Promise<{ id: string; version: number }> {
  const valid =
    Number.isInteger(year) &&
    year >= 2000 &&
    year <= 2100 &&
    items.length > 0 &&
    items.every((i) => isValidIsoDate(i.date) && i.date.startsWith(`${year}-`) && i.name.trim()) &&
    new Set(items.map((i) => i.date)).size === items.length;
  if (!valid) {
    await audit(db, actor, 'HOLIDAY_DRAFT', null, 'INVALID_DATA');
    throw new HolidayError('INVALID_DATA');
  }
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`holidays:${REGION}:${year}`}))`);
    const [last] = await tx
      .select({ v: sql<number>`coalesce(max(${holidayCalendars.version}), 0)::int` })
      .from(holidayCalendars)
      .where(and(eq(holidayCalendars.region, REGION), eq(holidayCalendars.year, year)));
    const version = (last?.v ?? 0) + 1;
    const [cal] = await tx
      .insert(holidayCalendars)
      .values({ region: REGION, year, version, source, reason, createdBy: actor })
      .returning({ id: holidayCalendars.id });
    if (!cal) throw new Error('calendario no creado');
    await tx
      .insert(holidays)
      .values(items.map((i) => ({ calendarId: cal.id, date: i.date, name: i.name.trim() })));
    return { id: cal.id, version };
  });
  await audit(db, actor, 'HOLIDAY_DRAFT', created.id, 'SUCCESS');
  return created;
}

/** Publica el borrador; la versión publicada anterior del año queda REEMPLAZADO (se conserva). */
export async function publish(db: Db, actor: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [cal] = await tx.select().from(holidayCalendars).where(eq(holidayCalendars.id, id));
    if (!cal) throw new HolidayError('NOT_FOUND');
    if (cal.status !== 'BORRADOR') throw new HolidayError('NOT_DRAFT');
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`holidays:${cal.region}:${cal.year}`}))`,
    );
    await tx
      .update(holidayCalendars)
      .set({ status: 'REEMPLAZADO' })
      .where(
        and(
          eq(holidayCalendars.region, cal.region),
          eq(holidayCalendars.year, cal.year),
          eq(holidayCalendars.status, 'PUBLICADO'),
        ),
      );
    await tx
      .update(holidayCalendars)
      .set({ status: 'PUBLICADO', publishedBy: actor, publishedAt: new Date() })
      .where(eq(holidayCalendars.id, id));
  });
  await audit(db, actor, 'HOLIDAY_PUBLISH', id, 'SUCCESS');
}

export async function listCalendars(db: Db, year?: number) {
  return db
    .select({
      id: holidayCalendars.id,
      year: holidayCalendars.year,
      version: holidayCalendars.version,
      status: holidayCalendars.status,
      source: holidayCalendars.source,
      reason: holidayCalendars.reason,
      createdAt: holidayCalendars.createdAt,
      publishedAt: holidayCalendars.publishedAt,
      days: sql<number>`(select count(*)::int from holidays h where h.calendar_id = ${holidayCalendars.id})`,
    })
    .from(holidayCalendars)
    .where(year ? eq(holidayCalendars.year, year) : undefined)
    .orderBy(desc(holidayCalendars.year), desc(holidayCalendars.version));
}

export async function calendarDays(db: Db, id: string) {
  const days = await db
    .select({ date: holidays.date, name: holidays.name })
    .from(holidays)
    .where(eq(holidays.calendarId, id))
    .orderBy(holidays.date);
  if (days.length === 0) throw new HolidayError('NOT_FOUND');
  return days;
}

export interface PublishedHolidays {
  set: Set<string>;
  /** id de los calendarios usados: se fijan en la revisión aprobada */
  calendarIds: string[];
  missingYears: number[];
}

/** Festivos publicados que cubren los años pedidos; informa los años sin calendario publicado. */
export async function publishedHolidays(db: Db, years: number[]): Promise<PublishedHolidays> {
  const cals = await db
    .select({ id: holidayCalendars.id, year: holidayCalendars.year })
    .from(holidayCalendars)
    .where(
      and(
        eq(holidayCalendars.region, REGION),
        eq(holidayCalendars.status, 'PUBLICADO'),
        inArray(holidayCalendars.year, years),
      ),
    );
  const rows = cals.length
    ? await db
        .select({ date: holidays.date })
        .from(holidays)
        .where(
          inArray(
            holidays.calendarId,
            cals.map((c) => c.id),
          ),
        )
    : [];
  const have = new Set(cals.map((c) => c.year));
  return {
    set: new Set(rows.map((r) => r.date)),
    calendarIds: cals.map((c) => c.id),
    missingYears: years.filter((y) => !have.has(y)),
  };
}
