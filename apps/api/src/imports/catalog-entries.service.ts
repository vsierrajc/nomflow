import { and, eq, gte, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  areaManagerAssignments,
  auditLogs,
  catalogEntries,
  catalogEntryHistory,
  companies,
  employeeSnapshots,
} from '../db/schema';
import { CATALOGS, type CatalogKind } from './catalog.parser';

export type EntryErrorCode =
  'COMPANY_REQUIRED' | 'COMPANY_NOT_FOUND' | 'EXISTS' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'IN_USE';

export class EntryError extends Error {
  constructor(
    readonly code: EntryErrorCode,
    readonly detail?: Record<string, number>,
  ) {
    super(code);
  }
}

export interface EntryListQuery {
  cEmp?: string | undefined;
  q?: string | undefined;
  active?: boolean | undefined;
  page: number;
  pageSize: number;
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
    .values({ actorAccountId: actor, action, resource: 'catalog_entry', resourceId, result });
}

const scope = (kind: CatalogKind, cEmp: string | undefined) =>
  CATALOGS[kind].global ? '' : (cEmp ?? '').trim();

export async function listEntries(db: Db, kind: CatalogKind, query: EntryListQuery) {
  const filters: SQL[] = [
    eq(catalogEntries.type, kind),
    eq(catalogEntries.cEmp, scope(kind, query.cEmp)),
  ];
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const cond = or(ilike(catalogEntries.code, like), ilike(catalogEntries.name, like));
    if (cond) filters.push(cond);
  }
  if (query.active !== undefined) filters.push(eq(catalogEntries.active, query.active));
  const where = and(...filters);
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(catalogEntries)
    .where(where);
  const items = await db
    .select({
      id: catalogEntries.id,
      code: catalogEntries.code,
      name: catalogEntries.name,
      active: catalogEntries.active,
      version: catalogEntries.version,
      updatedAt: catalogEntries.updatedAt,
    })
    .from(catalogEntries)
    .where(where)
    .orderBy(catalogEntries.code)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { total: Number(total), page: query.page, pageSize: query.pageSize, items };
}

export async function createEntry(
  db: Db,
  actorId: string,
  kind: CatalogKind,
  input: { cEmp?: string | undefined; code: string; name: string },
) {
  const cEmp = scope(kind, input.cEmp);
  if (!CATALOGS[kind].global) {
    if (!cEmp) throw new EntryError('COMPANY_REQUIRED');
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.cEmp, cEmp), eq(companies.active, true)));
    if (!company) throw new EntryError('COMPANY_NOT_FOUND');
  }
  const inserted = await db
    .insert(catalogEntries)
    .values({
      type: kind,
      cEmp,
      code: input.code.trim(),
      name: input.name.replace(/\s+/g, ' ').trim(),
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) throw new EntryError('EXISTS');
  await audit(db, actorId, 'CATALOG_ENTRY_CREATE', row.id, 'SUCCESS');
  return row;
}

async function usage(
  db: Db,
  kind: CatalogKind,
  cEmp: string,
  code: string,
): Promise<Record<string, number>> {
  const count = async (cond: SQL | undefined) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(employeeSnapshots)
      .where(cond);
    return Number(row?.n ?? 0);
  };
  const active = eq(employeeSnapshots.est, 'V');
  switch (kind) {
    case 'AREA': {
      const employees = await count(
        and(active, eq(employeeSnapshots.cEmp, cEmp), eq(employeeSnapshots.cArea, code)),
      );
      const today = new Date().toISOString().slice(0, 10);
      const [m] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(areaManagerAssignments)
        .where(
          and(
            eq(areaManagerAssignments.cEmp, cEmp),
            eq(areaManagerAssignments.cArea, code),
            or(isNull(areaManagerAssignments.validTo), gte(areaManagerAssignments.validTo, today)),
          ),
        );
      return { employees, managers: Number(m?.n ?? 0) };
    }
    case 'CCOSTO':
      return {
        employees: await count(
          and(active, eq(employeeSnapshots.cEmp, cEmp), eq(employeeSnapshots.cCos, code)),
        ),
      };
    case 'CARGO':
      return {
        employees: await count(
          and(active, eq(employeeSnapshots.cEmp, cEmp), eq(employeeSnapshots.cCar, code)),
        ),
      };
    case 'TIPO_CONTRATO':
      return { employees: await count(and(active, eq(employeeSnapshots.tipoContrato, code))) };
  }
}

export async function updateEntry(
  db: Db,
  actorId: string,
  kind: CatalogKind,
  id: string,
  input: { name: string; active: boolean; version: number },
) {
  const name = input.name.replace(/\s+/g, ' ').trim();
  const [current] = await db
    .select()
    .from(catalogEntries)
    .where(and(eq(catalogEntries.id, id), eq(catalogEntries.type, kind)));
  if (!current) throw new EntryError('NOT_FOUND');
  if (current.version !== input.version) throw new EntryError('VERSION_CONFLICT');

  if (current.active && !input.active) {
    const inUse = await usage(db, kind, current.cEmp, current.code);
    if (Object.values(inUse).some((n) => n > 0)) {
      await audit(db, actorId, 'CATALOG_ENTRY_UPDATE', id, 'IN_USE');
      throw new EntryError('IN_USE', inUse);
    }
  }
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(catalogEntries)
      .set({
        name,
        active: input.active,
        version: sql`${catalogEntries.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(catalogEntries.id, id), eq(catalogEntries.version, input.version)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    if (current.name !== name) {
      await tx
        .insert(catalogEntryHistory)
        .values({ entryId: id, oldName: current.name, newName: name });
    }
    return row;
  });
  if (!updated) throw new EntryError('VERSION_CONFLICT');
  await audit(db, actorId, 'CATALOG_ENTRY_UPDATE', id, 'SUCCESS');
  return updated;
}

export async function entryHistory(db: Db, kind: CatalogKind, id: string) {
  const [entry] = await db
    .select({ id: catalogEntries.id })
    .from(catalogEntries)
    .where(and(eq(catalogEntries.id, id), eq(catalogEntries.type, kind)));
  if (!entry) throw new EntryError('NOT_FOUND');
  return db
    .select({
      oldName: catalogEntryHistory.oldName,
      newName: catalogEntryHistory.newName,
      changedAt: catalogEntryHistory.changedAt,
    })
    .from(catalogEntryHistory)
    .where(eq(catalogEntryHistory.entryId, id))
    .orderBy(catalogEntryHistory.changedAt);
}
