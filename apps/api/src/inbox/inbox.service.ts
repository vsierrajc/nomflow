import { and, desc, eq, gte, inArray, or } from 'drizzle-orm';
import { activeCompaniesForRole } from '../auth/roles';
import type { Db } from '../db/client';
import {
  employeeSnapshots,
  permitRequests,
  vacationRequests,
  vacationRevisions,
} from '../db/schema';

export type TaskKind = 'VACACION_JEFE' | 'VACACION_FINAL' | 'PERMISO_JEFE' | 'VACACION_ACEPTAR';
export type StepState = 'done' | 'current' | 'todo' | 'rejected' | 'cancelled';

export interface InboxTask {
  kind: TaskKind;
  id: string;
  /** Qué hay que hacer, en palabras del usuario. */
  action: string;
  who: string;
  detail: string;
  since: string;
  href: string;
}

export interface FlowStep {
  label: string;
  state: StepState;
}

export interface InboxFlow {
  kind: 'VACACION' | 'PERMISO';
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  steps: FlowStep[];
  since: string;
  href: string;
}

const RECENT_DAYS = 14;

const VACATION_LABEL: Record<string, string> = {
  PENDIENTE_JEFE: 'Pendiente del jefe de área',
  REVISION_EMPLEADO: 'Cambio propuesto: espera su aceptación',
  PENDIENTE_FINAL: 'Pendiente de la aprobación final',
  APROBADA: 'Aprobada',
  RECHAZADA: 'Rechazada',
  CANCELADA: 'Cancelada',
};
const PERMIT_LABEL: Record<string, string> = {
  PENDIENTE_JEFE: 'Pendiente del jefe de área',
  APROBADO: 'Aprobado',
  RECHAZADO: 'Rechazado',
  CANCELADO: 'Cancelado',
};

const range = (a: string | null, b: string | null) =>
  a && b ? `${a} a ${b}` : 'Fechas por definir';

/** Pasos del flujo de vacaciones y en cuál va la solicitud. */
export function vacationSteps(status: string): FlowStep[] {
  const s = (
    enviada: StepState,
    jefe: StepState,
    final: StepState,
    resultado: StepState,
    resultadoLabel = 'Aprobada',
  ): FlowStep[] => [
    { label: 'Enviada', state: enviada },
    { label: 'Jefe de área', state: jefe },
    { label: 'Aprobación final', state: final },
    { label: resultadoLabel, state: resultado },
  ];
  switch (status) {
    case 'PENDIENTE_JEFE':
    case 'REVISION_EMPLEADO':
      return s('done', 'current', 'todo', 'todo');
    case 'PENDIENTE_FINAL':
      return s('done', 'done', 'current', 'todo');
    case 'APROBADA':
      return s('done', 'done', 'done', 'done');
    case 'RECHAZADA':
      return s('done', 'rejected', 'todo', 'todo', 'Rechazada');
    default:
      return s('done', 'cancelled', 'todo', 'todo', 'Cancelada');
  }
}

export function permitSteps(status: string): FlowStep[] {
  const done = status === 'APROBADO';
  return [
    { label: 'Enviado', state: 'done' },
    {
      label: 'Jefe de área',
      state:
        status === 'PENDIENTE_JEFE'
          ? 'current'
          : status === 'RECHAZADO'
            ? 'rejected'
            : status === 'CANCELADO'
              ? 'cancelled'
              : 'done',
    },
    { label: done ? 'Aprobado' : 'Resuelto', state: done ? 'done' : 'todo' },
  ];
}

export async function nameOf(db: Db, cache: Map<string, string>, nIde: string, nCont: string) {
  const key = `${nIde}|${nCont}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [e] = await db
    .select({ nombre: employeeSnapshots.nombre })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, nIde), eq(employeeSnapshots.nCont, nCont)));
  const name = e?.nombre ?? nIde;
  cache.set(key, name);
  return name;
}

export async function vacationDates(db: Db, rows: (typeof vacationRequests.$inferSelect)[]) {
  const out = new Map<string, string>();
  if (rows.length === 0) return out;
  const revs = await db
    .select({
      requestId: vacationRevisions.requestId,
      number: vacationRevisions.number,
      startDate: vacationRevisions.startDate,
      endDate: vacationRevisions.endDate,
    })
    .from(vacationRevisions)
    .where(
      inArray(
        vacationRevisions.requestId,
        rows.map((r) => r.id),
      ),
    );
  for (const r of rows) {
    const rev = revs.find((x) => x.requestId === r.id && x.number === r.currentRevision);
    out.set(r.id, range(rev?.startDate ?? null, rev?.endDate ?? null));
  }
  return out;
}

/** Actividades pendientes del usuario (lo que debe hacer) y el avance de sus propias solicitudes. */
export async function inboxFor(db: Db, accountId: string) {
  const names = new Map<string, string>();
  const tasks: InboxTask[] = [];

  // Jefe de área: vacaciones por decidir.
  const asManager = await db
    .select()
    .from(vacationRequests)
    .where(
      and(
        eq(vacationRequests.managerAccountId, accountId),
        eq(vacationRequests.status, 'PENDIENTE_JEFE'),
      ),
    )
    .orderBy(vacationRequests.updatedAt);
  // Aprobador final: solo las empresas donde tiene el rol vigente.
  const companies = await activeCompaniesForRole(db, accountId, 'VACATION_FINAL_APPROVER');
  const asFinal =
    companies.length === 0
      ? []
      : await db
          .select()
          .from(vacationRequests)
          .where(
            and(
              eq(vacationRequests.status, 'PENDIENTE_FINAL'),
              inArray(vacationRequests.cEmp, companies),
            ),
          )
          .orderBy(vacationRequests.updatedAt);
  // Empleado: cambios propuestos por el jefe que debe aceptar.
  const toAccept = await db
    .select()
    .from(vacationRequests)
    .where(
      and(
        eq(vacationRequests.accountId, accountId),
        eq(vacationRequests.status, 'REVISION_EMPLEADO'),
      ),
    )
    .orderBy(vacationRequests.updatedAt);
  const permits = await db
    .select()
    .from(permitRequests)
    .where(
      and(
        eq(permitRequests.managerAccountId, accountId),
        eq(permitRequests.status, 'PENDIENTE_JEFE'),
      ),
    )
    .orderBy(permitRequests.updatedAt);

  const dates = await vacationDates(db, [...asManager, ...asFinal, ...toAccept]);
  for (const r of asManager)
    tasks.push({
      kind: 'VACACION_JEFE',
      id: r.id,
      action: 'Decidir solicitud de vacaciones',
      who: await nameOf(db, names, r.nIde, r.nCont),
      detail: dates.get(r.id) ?? '',
      since: r.updatedAt.toISOString(),
      href: '/aprobaciones',
    });
  for (const r of asFinal)
    tasks.push({
      kind: 'VACACION_FINAL',
      id: r.id,
      action: 'Aprobación final de vacaciones',
      who: await nameOf(db, names, r.nIde, r.nCont),
      detail: dates.get(r.id) ?? '',
      since: r.updatedAt.toISOString(),
      href: '/aprobaciones',
    });
  for (const r of permits)
    tasks.push({
      kind: 'PERMISO_JEFE',
      id: r.id,
      action: 'Decidir solicitud de permiso',
      who: await nameOf(db, names, r.nIde, r.nCont),
      detail: `${r.typeName}: ${range(r.startDate, r.endDate)}`,
      since: r.updatedAt.toISOString(),
      href: '/aprobaciones',
    });
  for (const r of toAccept)
    tasks.push({
      kind: 'VACACION_ACEPTAR',
      id: r.id,
      action: 'Aceptar o rechazar el cambio propuesto a sus vacaciones',
      who: 'Su solicitud',
      detail: dates.get(r.id) ?? '',
      since: r.updatedAt.toISOString(),
      href: '/vacaciones',
    });
  tasks.sort((a, b) => a.since.localeCompare(b.since));

  // Mis solicitudes: las abiertas y las resueltas en los últimos días, con el paso en que van.
  const recent = new Date(Date.now() - RECENT_DAYS * 86_400_000);
  const mineVac = await db
    .select()
    .from(vacationRequests)
    .where(
      and(
        eq(vacationRequests.accountId, accountId),
        or(
          inArray(vacationRequests.status, [
            'PENDIENTE_JEFE',
            'REVISION_EMPLEADO',
            'PENDIENTE_FINAL',
          ]),
          gte(vacationRequests.updatedAt, recent),
        ),
      ),
    )
    .orderBy(desc(vacationRequests.updatedAt))
    .limit(50);
  const minePer = await db
    .select()
    .from(permitRequests)
    .where(
      and(
        eq(permitRequests.accountId, accountId),
        or(eq(permitRequests.status, 'PENDIENTE_JEFE'), gte(permitRequests.updatedAt, recent)),
      ),
    )
    .orderBy(desc(permitRequests.updatedAt))
    .limit(50);
  const mineDates = await vacationDates(db, mineVac);
  const flows: InboxFlow[] = [
    ...mineVac.map((r) => ({
      kind: 'VACACION' as const,
      id: r.id,
      title: `Vacaciones: ${mineDates.get(r.id) ?? ''}`,
      status: r.status,
      statusLabel: VACATION_LABEL[r.status] ?? r.status,
      steps: vacationSteps(r.status),
      since: r.updatedAt.toISOString(),
      href: '/vacaciones',
    })),
    ...minePer.map((r) => ({
      kind: 'PERMISO' as const,
      id: r.id,
      title: `Permiso ${r.typeName}: ${range(r.startDate, r.endDate)}`,
      status: r.status,
      statusLabel: PERMIT_LABEL[r.status] ?? r.status,
      steps: permitSteps(r.status),
      since: r.updatedAt.toISOString(),
      href: '/permisos',
    })),
  ].sort((a, b) => b.since.localeCompare(a.since));

  return { tasks, flows };
}

export async function inboxCount(db: Db, accountId: string): Promise<number> {
  return (await inboxFor(db, accountId)).tasks.length;
}
