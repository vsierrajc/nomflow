import { and, eq, ilike, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { revokeAllForAccount } from '../auth/session.service';
import {
  accounts,
  auditLogs,
  catalogEntries,
  companies,
  employeeChanges,
  employeeSnapshots,
} from '../db/schema';
import { isDecimalText } from '../payroll/decimal';

export type EmployeeErrorCode = 'NOT_FOUND' | 'VERSION_CONFLICT' | 'INVALID' | 'EXISTS';

export class EmployeeError extends Error {
  constructor(
    readonly code: EmployeeErrorCode,
    readonly issues: string[] = [],
  ) {
    super(code);
  }
}

export interface EmployeeInput {
  cEmp: string;
  nIde: string;
  nCont: string;
  nombre: string;
  nombres?: string | null | undefined;
  apellidos?: string | null | undefined;
  email: string;
  est: 'V' | 'C';
  cArea: string;
  cCos?: string | null | undefined;
  cCar?: string | null | undefined;
  tipoContrato: string;
  fIni: string;
  fecNac?: string | null | undefined;
  sAct?: string | null | undefined;
  hliq?: string | null | undefined;
  sexo?: string | null | undefined;
  turno?: string | null | undefined;
  celular?: string | null | undefined;
  profesion?: string | null | undefined;
  nivelEducativo?: string | null | undefined;
}

export type EmployeeUpdate = Omit<EmployeeInput, 'nIde' | 'nCont'>;

const FIELDS = [
  'cEmp',
  'nombre',
  'nombres',
  'apellidos',
  'email',
  'est',
  'cArea',
  'area',
  'cCos',
  'cCosto',
  'cCar',
  'cargo',
  'tipoContrato',
  'fIni',
  'fecNac',
  'sAct',
  'hliq',
  'sexo',
  'turno',
  'celular',
  'profesion',
  'nivelEducativo',
] as const;
type Field = (typeof FIELDS)[number];

type Row = typeof employeeSnapshots.$inferSelect;

const clean = (v: string | null | undefined) => {
  const t = v?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
};

const isIsoDate = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'employee', resourceId, result });
}

async function catalogName(
  db: Db,
  type: 'AREA' | 'CCOSTO' | 'CARGO' | 'TIPO_CONTRATO',
  cEmp: string,
  code: string,
) {
  const [row] = await db
    .select({ name: catalogEntries.name })
    .from(catalogEntries)
    .where(
      and(
        eq(catalogEntries.type, type),
        eq(catalogEntries.cEmp, cEmp),
        eq(catalogEntries.code, code),
        eq(catalogEntries.active, true),
      ),
    );
  return row?.name ?? null;
}

interface Normalized {
  values: Pick<Row, Field>;
  issues: string[];
}

async function normalize(
  db: Db,
  input: EmployeeUpdate,
  ctx: { nIde: string; excludeId?: string },
): Promise<Normalized> {
  const issues: string[] = [];
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    issues.push('EMAIL: correo inválido');
  if (input.est !== 'V' && input.est !== 'C') issues.push('EST: debe ser V o C');
  if (!isIsoDate(input.fIni)) issues.push('F_INI: fecha inválida');
  if (input.fecNac && !isIsoDate(input.fecNac)) issues.push('FEC_NAC: fecha inválida');
  const sAct = clean(input.sAct);
  if (sAct !== null && (!isDecimalText(sAct) || sAct.startsWith('-')))
    issues.push('S_ACT: importe inválido');

  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.cEmp, input.cEmp), eq(companies.active, true)));
  if (!company) issues.push('C_EMP: empresa inexistente o inactiva');

  let area: string | null = null;
  let cCosto: string | null = null;
  let cargo: string | null = null;
  if (company) {
    area = await catalogName(db, 'AREA', input.cEmp, input.cArea);
    if (!area) issues.push('C_AREA: código inexistente o inactivo en el catálogo');
    if (clean(input.cCos)) {
      cCosto = await catalogName(db, 'CCOSTO', input.cEmp, clean(input.cCos) as string);
      if (!cCosto) issues.push('C_COS: código inexistente o inactivo en el catálogo');
    }
    if (clean(input.cCar)) {
      cargo = await catalogName(db, 'CARGO', input.cEmp, clean(input.cCar) as string);
      if (!cargo) issues.push('C_CAR: código inexistente o inactivo en el catálogo');
    }
  }
  if (!(await catalogName(db, 'TIPO_CONTRATO', '', input.tipoContrato)))
    issues.push('TIPO_CONTRATO: código inexistente o inactivo en el catálogo');

  const owner = await db
    .select({ nIde: employeeSnapshots.nIde })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.email, email), ne(employeeSnapshots.nIde, ctx.nIde)))
    .limit(1);
  if (owner.length > 0) issues.push('EMAIL: el correo pertenece a otra persona');

  return {
    issues,
    values: {
      cEmp: input.cEmp,
      nombre: clean(input.nombre) ?? '',
      nombres: clean(input.nombres),
      apellidos: clean(input.apellidos),
      email,
      est: input.est,
      cArea: input.cArea,
      area,
      cCos: clean(input.cCos),
      cCosto,
      cCar: clean(input.cCar),
      cargo,
      tipoContrato: input.tipoContrato,
      fIni: input.fIni,
      fecNac: input.fecNac ?? null,
      sAct,
      hliq: clean(input.hliq),
      sexo: clean(input.sexo),
      turno: clean(input.turno),
      celular: clean(input.celular),
      profesion: clean(input.profesion),
      nivelEducativo: clean(input.nivelEducativo),
    },
  };
}

async function activeConflict(db: Db, nIde: string, exceptId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: employeeSnapshots.id })
    .from(employeeSnapshots)
    .where(
      and(
        eq(employeeSnapshots.nIde, nIde),
        eq(employeeSnapshots.est, 'V'),
        exceptId ? ne(employeeSnapshots.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const decimal = (v: string | null) => (v === null ? null : String(Number(v)));

function diff(
  before: Row,
  after: Pick<Row, Field>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of FIELDS) {
    const a = f === 'sAct' ? decimal(before[f]) : before[f];
    const b = f === 'sAct' ? decimal(after[f]) : after[f];
    if ((a ?? null) !== (b ?? null)) out[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return out;
}

export interface EmployeeListQuery {
  q?: string | undefined;
  est?: 'V' | 'C' | undefined;
  cEmp?: string | undefined;
  cArea?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listEmployees(db: Db, query: EmployeeListQuery) {
  const filters: SQL[] = [];
  if (query.q) {
    const like = `%${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const cond = or(
      ilike(employeeSnapshots.nIde, like),
      ilike(employeeSnapshots.nombre, like),
      ilike(employeeSnapshots.email, like),
    );
    if (cond) filters.push(cond);
  }
  if (query.est) filters.push(eq(employeeSnapshots.est, query.est));
  if (query.cEmp) filters.push(eq(employeeSnapshots.cEmp, query.cEmp));
  if (query.cArea) filters.push(eq(employeeSnapshots.cArea, query.cArea));
  const where = filters.length ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(employeeSnapshots)
    .where(where);
  const items = await db
    .select({
      id: employeeSnapshots.id,
      nIde: employeeSnapshots.nIde,
      nCont: employeeSnapshots.nCont,
      nombre: employeeSnapshots.nombre,
      email: employeeSnapshots.email,
      est: employeeSnapshots.est,
      cEmp: employeeSnapshots.cEmp,
      cArea: employeeSnapshots.cArea,
      area: employeeSnapshots.area,
      cargo: employeeSnapshots.cargo,
      source: employeeSnapshots.source,
      version: employeeSnapshots.version,
      hasAccount: sql<boolean>`exists (select 1 from accounts a where a.n_ide = "employee_snapshots"."n_ide" and a.status <> 'BLOQUEADA')`,
    })
    .from(employeeSnapshots)
    .where(where)
    .orderBy(employeeSnapshots.nombre, employeeSnapshots.nIde, employeeSnapshots.nCont)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { total: Number(total), page: query.page, pageSize: query.pageSize, items };
}

export async function getEmployee(db: Db, actorId: string, id: string) {
  const [row] = await db.select().from(employeeSnapshots).where(eq(employeeSnapshots.id, id));
  if (!row) throw new EmployeeError('NOT_FOUND');
  await audit(db, actorId, 'EMPLOYEE_VIEW', id, 'SUCCESS');
  return row;
}

export async function createEmployee(
  db: Db,
  actorId: string,
  input: EmployeeInput,
  reason: string,
) {
  const { nIde, nCont, ...rest } = input;
  const { values, issues } = await normalize(db, rest, { nIde });
  if (values.est === 'V' && (await activeConflict(db, nIde)))
    issues.push('EST: la persona ya tiene otro contrato vigente');
  const sameEmail = await db
    .select({ email: employeeSnapshots.email })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, nIde))
    .limit(1);
  if (sameEmail[0] && sameEmail[0].email !== values.email)
    issues.push('EMAIL: la persona ya tiene otro correo registrado');
  if (issues.length > 0) {
    await audit(db, actorId, 'EMPLOYEE_CREATE', null, 'INVALID');
    throw new EmployeeError('INVALID', issues);
  }
  const inserted = await db
    .insert(employeeSnapshots)
    .values({ nIde, nCont, ...values, source: 'MANUAL' })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) {
    await audit(db, actorId, 'EMPLOYEE_CREATE', null, 'EXISTS');
    throw new EmployeeError('EXISTS');
  }
  await db
    .insert(employeeChanges)
    .values({ employeeId: row.id, changedBy: actorId, action: 'CREATE', reason, changes: {} });
  await audit(db, actorId, 'EMPLOYEE_CREATE', row.id, 'SUCCESS');
  return row;
}

export async function updateEmployee(
  db: Db,
  actorId: string,
  id: string,
  input: EmployeeUpdate & { version: number },
  reason: string,
) {
  const [current] = await db.select().from(employeeSnapshots).where(eq(employeeSnapshots.id, id));
  if (!current) throw new EmployeeError('NOT_FOUND');
  if (current.version !== input.version) throw new EmployeeError('VERSION_CONFLICT');
  const { version: _v, ...rest } = input;
  void _v;
  const { values, issues } = await normalize(db, rest, { nIde: current.nIde, excludeId: id });
  if (values.est === 'V' && (await activeConflict(db, current.nIde, id)))
    issues.push('EST: la persona ya tiene otro contrato vigente');
  if (values.email !== current.email) {
    const [account] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.nIde, current.nIde), ne(accounts.status, 'BLOQUEADA')));
    if (account)
      issues.push(
        'EMAIL: la persona ya tiene cuenta; el cambio de correo requiere resolución administrativa',
      );
  }
  if (issues.length > 0) {
    await audit(db, actorId, 'EMPLOYEE_UPDATE', id, 'INVALID');
    throw new EmployeeError('INVALID', issues);
  }
  const changes = diff(current, values);
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(employeeSnapshots)
      .set({
        ...values,
        source: 'MANUAL',
        version: sql`${employeeSnapshots.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(employeeSnapshots.id, id), eq(employeeSnapshots.version, input.version)))
      .returning();
    const row = rows[0];
    if (!row) return null;
    const action =
      current.est !== row.est ? (row.est === 'C' ? 'DEACTIVATE' : 'REACTIVATE') : 'UPDATE';
    await tx
      .insert(employeeChanges)
      .values({ employeeId: id, changedBy: actorId, action, reason, changes });
    return row;
  });
  if (!updated) throw new EmployeeError('VERSION_CONFLICT');
  if (current.est === 'V' && updated.est === 'C') {
    const accs = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.nIde, current.nIde));
    for (const a of accs) await revokeAllForAccount(db, a.id);
  }
  await audit(db, actorId, 'EMPLOYEE_UPDATE', id, 'SUCCESS');
  return updated;
}

export async function setEmployeeStatus(
  db: Db,
  actorId: string,
  id: string,
  est: 'V' | 'C',
  version: number,
  reason: string,
) {
  const [current] = await db.select().from(employeeSnapshots).where(eq(employeeSnapshots.id, id));
  if (!current) throw new EmployeeError('NOT_FOUND');
  if (current.version !== version) throw new EmployeeError('VERSION_CONFLICT');

  if (est === 'C') {
    if (current.est === 'C') return current;
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(employeeSnapshots)
        .set({
          est: 'C',
          source: 'MANUAL',
          version: sql`${employeeSnapshots.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(employeeSnapshots.id, id), eq(employeeSnapshots.version, version)))
        .returning();
      const row = rows[0];
      if (!row) return null;
      await tx.insert(employeeChanges).values({
        employeeId: id,
        changedBy: actorId,
        action: 'DEACTIVATE',
        reason,
        changes: { est: { from: 'V', to: 'C' } },
      });
      return row;
    });
    if (!updated) throw new EmployeeError('VERSION_CONFLICT');
    const accs = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.nIde, current.nIde));
    for (const a of accs) await revokeAllForAccount(db, a.id);
    await audit(db, actorId, 'EMPLOYEE_UPDATE', id, 'SUCCESS');
    return updated;
  }

  const {
    nIde: _n,
    nCont: _c,
    id: _i,
    version: _v,
    source: _s,
    createdAt: _ca,
    updatedAt: _u,
    importBatchId: _b,
    ...rest
  } = current;
  void [_n, _c, _i, _v, _s, _ca, _u, _b];
  return updateEmployee(
    db,
    actorId,
    id,
    {
      cEmp: rest.cEmp ?? '',
      nombre: rest.nombre ?? '',
      nombres: rest.nombres,
      apellidos: rest.apellidos,
      email: rest.email,
      est,
      cArea: rest.cArea ?? '',
      cCos: rest.cCos,
      cCar: rest.cCar,
      tipoContrato: rest.tipoContrato ?? '',
      fIni: rest.fIni ?? '',
      fecNac: rest.fecNac,
      sAct: rest.sAct,
      hliq: rest.hliq,
      sexo: rest.sexo,
      turno: rest.turno,
      celular: rest.celular,
      profesion: rest.profesion,
      nivelEducativo: rest.nivelEducativo,
      version,
    },
    reason,
  );
}

export async function employeeHistory(db: Db, id: string) {
  const [row] = await db
    .select({ id: employeeSnapshots.id })
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.id, id));
  if (!row) throw new EmployeeError('NOT_FOUND');
  return db
    .select({
      action: employeeChanges.action,
      reason: employeeChanges.reason,
      changes: employeeChanges.changes,
      at: employeeChanges.at,
      by: accounts.email,
    })
    .from(employeeChanges)
    .innerJoin(accounts, eq(accounts.id, employeeChanges.changedBy))
    .where(eq(employeeChanges.employeeId, id))
    .orderBy(employeeChanges.at);
}
