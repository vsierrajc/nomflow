import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLogs,
  employeeSnapshots,
  permitActions,
  permitRequests,
  permitSupports,
  permitTypes,
  vacaciones,
} from '../db/schema';
import { hasActiveRole } from '../auth/roles';
import { resolveAreaManager } from '../org/area-managers.service';
import { diffDays, isValidIsoDate } from './business-days';
import { activeContract } from './prog-vac.service';

export type PermitErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'SELF_APPROVAL'
  | 'INVALID_STATE'
  | 'NO_MANAGER'
  | 'NO_ACTIVE_CONTRACT'
  | 'TYPE_NOT_AVAILABLE'
  | 'INVALID_DATES'
  | 'INVALID_HOURS'
  | 'MAX_DAYS'
  | 'JUSTIFICATION'
  | 'SUPPORT_REQUIRED'
  | 'INVALID_SUPPORT'
  | 'OVERLAP'
  | 'REASON_REQUIRED'
  | 'INVALID_TYPE'
  | 'EXISTS'
  | 'VERSION_CONFLICT';

export class PermitError extends Error {
  constructor(readonly code: PermitErrorCode) {
    super(code);
  }
}

export const MAX_SUPPORT_BYTES = Number(process.env.PERMIT_SUPPORT_MAX_BYTES ?? 2 * 1024 * 1024);
export const OPEN = ['PENDIENTE_JEFE'] as const;
const BLOCKING = [...OPEN, 'APROBADO'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Runner = Db | Tx;

async function audit(db: Db, actor: string, action: string, id: string | null, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'permit', resourceId: id, result });
}

/* ------------------------------ tipos de permiso ------------------------------ */

export interface PermitTypeInput {
  code: string;
  name: string;
  description?: string | null | undefined;
  supportRequired: boolean;
  allowsHours: boolean;
  maxDays?: number | null | undefined;
  active: boolean;
}

const validType = (i: PermitTypeInput) =>
  /^[A-Z0-9_]{1,30}$/.test(i.code) &&
  i.name.trim().length > 0 &&
  i.name.length <= 100 &&
  (i.maxDays == null || (Number.isInteger(i.maxDays) && i.maxDays >= 1 && i.maxDays <= 365));

export async function listTypes(db: Db, onlyActive: boolean) {
  return db
    .select()
    .from(permitTypes)
    .where(onlyActive ? eq(permitTypes.active, true) : undefined)
    .orderBy(permitTypes.name);
}

export async function createType(db: Db, actor: string, input: PermitTypeInput) {
  const data = { ...input, code: input.code.trim().toUpperCase() };
  if (!validType(data)) {
    await audit(db, actor, 'PERMIT_TYPE_CREATE', null, 'INVALID_TYPE');
    throw new PermitError('INVALID_TYPE');
  }
  const rows = await db
    .insert(permitTypes)
    .values({
      code: data.code,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      supportRequired: data.supportRequired,
      allowsHours: data.allowsHours,
      maxDays: data.maxDays ?? null,
      active: data.active,
    })
    .onConflictDoNothing()
    .returning();
  const row = rows[0];
  if (!row) {
    await audit(db, actor, 'PERMIT_TYPE_CREATE', null, 'EXISTS');
    throw new PermitError('EXISTS');
  }
  await audit(db, actor, 'PERMIT_TYPE_CREATE', row.id, 'SUCCESS');
  return row;
}

/** El código no cambia; el resto sí, con control de versión. Las solicitudes en curso conservan su copia. */
export async function updateType(
  db: Db,
  actor: string,
  id: string,
  input: Omit<PermitTypeInput, 'code'> & { version: number },
) {
  if (!validType({ ...input, code: 'X' })) {
    await audit(db, actor, 'PERMIT_TYPE_UPDATE', id, 'INVALID_TYPE');
    throw new PermitError('INVALID_TYPE');
  }
  const rows = await db
    .update(permitTypes)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      supportRequired: input.supportRequired,
      allowsHours: input.allowsHours,
      maxDays: input.maxDays ?? null,
      active: input.active,
      version: input.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(permitTypes.id, id), eq(permitTypes.version, input.version)))
    .returning();
  if (rows.length === 0) {
    const [exists] = await db
      .select({ id: permitTypes.id })
      .from(permitTypes)
      .where(eq(permitTypes.id, id));
    const code = exists ? 'VERSION_CONFLICT' : 'NOT_FOUND';
    await audit(db, actor, 'PERMIT_TYPE_UPDATE', id, code);
    throw new PermitError(code);
  }
  await audit(db, actor, 'PERMIT_TYPE_UPDATE', id, 'SUCCESS');
  return rows[0];
}

/* --------------------------------- solicitud --------------------------------- */

export interface SupportFile {
  buffer: Buffer;
  fileName: string;
}

/** El tipo de contenido sale de los bytes iniciales, no de lo que declare el cliente. */
export function sniffSupport(buf: Buffer): string | null {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

export interface PermitInput {
  typeId: string;
  start: string;
  end: string;
  startTime?: string | undefined;
  endTime?: string | undefined;
  justification: string;
  support?: SupportFile | undefined;
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

async function overlaps(
  db: Runner,
  nIde: string,
  start: string,
  end: string,
  times: { s: string | null; e: string | null },
): Promise<boolean> {
  const others = await db
    .select()
    .from(permitRequests)
    .where(
      and(
        eq(permitRequests.nIde, nIde),
        inArray(permitRequests.status, BLOCKING),
        sql`${permitRequests.startDate} <= ${end} and ${permitRequests.endDate} >= ${start}`,
      ),
    );
  for (const o of others) {
    // Dos permisos por horas el mismo día solo chocan si sus horarios se cruzan.
    if (
      times.s &&
      times.e &&
      o.startTime &&
      o.endTime &&
      o.startDate === o.endDate &&
      start === end
    ) {
      if (toMinutes(times.s) < toMinutes(o.endTime) && toMinutes(o.startTime) < toMinutes(times.e))
        return true;
      continue;
    }
    return true;
  }
  const [vac] = await db
    .select({ id: vacaciones.id })
    .from(vacaciones)
    .where(
      and(
        eq(vacaciones.nIde, nIde),
        sql`${vacaciones.fecIniDis} <= ${end} and ${vacaciones.fecFinDis} >= ${start}`,
      ),
    )
    .limit(1);
  return Boolean(vac);
}

export async function submitPermit(db: Db, accountId: string, input: PermitInput) {
  const c = await activeContract(db, accountId);
  if (!c?.cEmp || !c.cArea) throw new PermitError('NO_ACTIVE_CONTRACT');
  const [type] = await db.select().from(permitTypes).where(eq(permitTypes.id, input.typeId));
  if (!type || !type.active) throw new PermitError('TYPE_NOT_AVAILABLE');
  if (!isValidIsoDate(input.start) || !isValidIsoDate(input.end) || input.end < input.start)
    throw new PermitError('INVALID_DATES');
  if (type.maxDays !== null && diffDays(input.start, input.end) + 1 > type.maxDays)
    throw new PermitError('MAX_DAYS');
  const hasTimes = input.startTime !== undefined || input.endTime !== undefined;
  if (hasTimes) {
    if (
      !type.allowsHours ||
      input.start !== input.end ||
      !input.startTime ||
      !input.endTime ||
      !TIME_RE.test(input.startTime) ||
      !TIME_RE.test(input.endTime) ||
      toMinutes(input.endTime) <= toMinutes(input.startTime)
    )
      throw new PermitError('INVALID_HOURS');
  }
  const justification = input.justification.trim();
  if (justification.length < 10 || justification.length > 1000)
    throw new PermitError('JUSTIFICATION');
  let contentType: string | null = null;
  if (input.support) {
    contentType = sniffSupport(input.support.buffer);
    if (!contentType || input.support.buffer.length > MAX_SUPPORT_BYTES)
      throw new PermitError('INVALID_SUPPORT');
  } else if (type.supportRequired) throw new PermitError('SUPPORT_REQUIRED');

  const today = new Date().toISOString().slice(0, 10);
  const manager = await resolveAreaManager(db, c.cEmp, c.cArea, today);
  if (!manager) {
    await audit(db, accountId, 'PERMIT_SUBMIT', null, 'NO_MANAGER');
    throw new PermitError('NO_MANAGER');
  }
  const times = { s: input.startTime ?? null, e: input.endTime ?? null };
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify([type.id, input.start, input.end, times.s, times.e, justification, c.nIde]),
    )
    .digest('hex');

  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`permit-person:${c.nIde}`}))`);
    if (await overlaps(tx, c.nIde, input.start, input.end, times)) throw new PermitError('OVERLAP');
    const [req] = await tx
      .insert(permitRequests)
      .values({
        accountId,
        nIde: c.nIde,
        nCont: c.nCont,
        cEmp: c.cEmp ?? '',
        cArea: c.cArea ?? '',
        managerAccountId: manager,
        typeId: type.id,
        typeName: type.name,
        startDate: input.start,
        endDate: input.end,
        startTime: times.s,
        endTime: times.e,
        justification,
        contentHash,
      })
      .returning({ id: permitRequests.id });
    if (!req) throw new Error('permiso no creado');
    if (input.support && contentType)
      await tx.insert(permitSupports).values({
        requestId: req.id,
        fileName: input.support.fileName.replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'soporte',
        contentType,
        data: input.support.buffer,
        sha256: createHash('sha256').update(input.support.buffer).digest('hex'),
        sizeBytes: input.support.buffer.length,
      });
    await tx.insert(permitActions).values({
      requestId: req.id,
      actorAccountId: accountId,
      action: 'ENVIAR',
      contentHash,
    });
    return req.id;
  });
  await audit(db, accountId, 'PERMIT_SUBMIT', id, 'SUCCESS');
  return { id };
}

/* ---------------------------------- consulta ---------------------------------- */

type Row = typeof permitRequests.$inferSelect;

async function names(db: Runner, rows: Row[]) {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (map.has(r.nIde)) continue;
    const [e] = await db
      .select({ n: employeeSnapshots.nombre })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, r.nIde), eq(employeeSnapshots.nCont, r.nCont)));
    map.set(r.nIde, e?.n ?? r.nIde);
  }
  return map;
}

const view = (r: Row, employee: string) => ({
  id: r.id,
  status: r.status,
  employee,
  nIde: r.nIde,
  typeName: r.typeName,
  start: r.startDate,
  end: r.endDate,
  startTime: r.startTime,
  endTime: r.endTime,
  justification: r.justification,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export async function listMine(db: Db, accountId: string) {
  const rows = await db
    .select()
    .from(permitRequests)
    .where(eq(permitRequests.accountId, accountId))
    .orderBy(desc(permitRequests.createdAt))
    .limit(100);
  const n = await names(db, rows);
  return rows.map((r) => view(r, n.get(r.nIde) ?? r.nIde));
}

export async function listAssignedToManager(db: Db, managerId: string) {
  const rows = await db
    .select()
    .from(permitRequests)
    .where(eq(permitRequests.managerAccountId, managerId))
    .orderBy(desc(permitRequests.updatedAt))
    .limit(200);
  const n = await names(db, rows);
  return rows.map((r) => view(r, n.get(r.nIde) ?? r.nIde));
}

/** Solo ven una solicitud su dueño y el jefe de área al que se asignó al enviarla. */
function access(viewerId: string, req: Row) {
  const isOwner = req.accountId === viewerId;
  const isManager = req.managerAccountId === viewerId;
  return { isOwner, isManager, allowed: isOwner || isManager };
}

async function load(db: Runner, id: string) {
  const [req] = await db.select().from(permitRequests).where(eq(permitRequests.id, id));
  if (!req) throw new PermitError('NOT_FOUND');
  return req;
}

export async function detail(db: Db, viewerId: string, id: string) {
  const req = await load(db, id);
  const a = access(viewerId, req);
  if (!a.allowed) throw new PermitError('NOT_FOUND');
  const [support] = await db
    .select({
      fileName: permitSupports.fileName,
      contentType: permitSupports.contentType,
      sizeBytes: permitSupports.sizeBytes,
    })
    .from(permitSupports)
    .where(eq(permitSupports.requestId, id));
  const actions = await db
    .select({
      action: permitActions.action,
      comment: permitActions.comment,
      at: permitActions.at,
      actor: permitActions.actorAccountId,
    })
    .from(permitActions)
    .where(eq(permitActions.requestId, id))
    .orderBy(permitActions.at);
  const n = await names(db, [req]);
  return {
    ...view(req, n.get(req.nIde) ?? req.nIde),
    isOwner: a.isOwner,
    support: support ?? null,
    actions: actions.map((x) => ({
      action: x.action,
      comment: x.comment,
      at: x.at,
      byMe: x.actor === viewerId,
    })),
  };
}

export async function getSupport(db: Db, viewerId: string, id: string) {
  const req = await load(db, id);
  if (!access(viewerId, req).allowed) throw new PermitError('NOT_FOUND');
  const [s] = await db.select().from(permitSupports).where(eq(permitSupports.requestId, id));
  if (!s) throw new PermitError('NOT_FOUND');
  await audit(db, viewerId, 'PERMIT_SUPPORT_DOWNLOAD', id, 'SUCCESS');
  return s;
}

/* -------------------------------- decisiones -------------------------------- */

async function transition(
  db: Db,
  actor: string,
  id: string,
  opts: {
    from: string[];
    to: (req: Row) => string;
    action: string;
    comment?: string | null;
    guard: (req: Row) => Promise<void> | void;
  },
) {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`permit:${id}`}))`);
      const req = await load(tx, id);
      await opts.guard(req);
      if (!opts.from.includes(req.status)) throw new PermitError('INVALID_STATE');
      await tx
        .update(permitRequests)
        .set({ status: opts.to(req), updatedAt: new Date() })
        .where(eq(permitRequests.id, id));
      await tx.insert(permitActions).values({
        requestId: id,
        actorAccountId: actor,
        action: opts.action,
        comment: opts.comment ?? null,
        contentHash: req.contentHash,
      });
    });
  } catch (e) {
    await audit(
      db,
      actor,
      `PERMIT_${opts.action}`,
      id,
      e instanceof PermitError ? e.code : 'ERROR',
    );
    throw e;
  }
  await audit(db, actor, `PERMIT_${opts.action}`, id, 'SUCCESS');
}

async function asManager(db: Runner, actor: string, req: Row) {
  if (req.managerAccountId !== actor) throw new PermitError('NOT_FOUND');
  if (req.accountId === actor) throw new PermitError('SELF_APPROVAL');
  if (!(await hasActiveRole(db as Db, actor, ['AREA_MANAGER']))) throw new PermitError('FORBIDDEN');
}

const needReason = (reason: string | undefined) => {
  if (!reason || reason.trim().length < 10) throw new PermitError('REASON_REQUIRED');
  return reason.trim();
};

export function cancelPermit(db: Db, accountId: string, id: string) {
  return transition(db, accountId, id, {
    from: [...OPEN],
    to: () => 'CANCELADO',
    action: 'CANCELAR',
    guard: (req) => {
      if (req.accountId !== accountId) throw new PermitError('NOT_FOUND');
    },
  });
}

/** El jefe de área decide; no hay más aprobaciones. */
export function managerApprove(db: Db, actor: string, id: string) {
  return transition(db, actor, id, {
    from: ['PENDIENTE_JEFE'],
    to: () => 'APROBADO',
    action: 'APROBAR',
    guard: (req) => asManager(db, actor, req),
  });
}

export function managerReject(db: Db, actor: string, id: string, reason?: string) {
  const comment = needReason(reason);
  return transition(db, actor, id, {
    from: ['PENDIENTE_JEFE'],
    to: () => 'RECHAZADO',
    action: 'RECHAZAR',
    comment,
    guard: (req) => asManager(db, actor, req),
  });
}
