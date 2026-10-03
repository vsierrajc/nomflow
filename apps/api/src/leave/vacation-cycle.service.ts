import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, employeeSnapshots, progVac, progVacAdjustments } from '../db/schema';
import { addDays, isValidIsoDate } from './business-days';

/** Días de un ciclo de causación y días de vacación que otorga (SSD, regla de negocio confirmada). */
export const CYCLE_DAYS = 360;
export const CYCLE_VACATION_DAYS = 15;
/** Máximo de períodos disponibles (ACTIVA, DISP > 0) que un contrato puede acumular a la vez. */
export const MAX_ACCRUED_PERIODS = 3;
/** Si al activarse la regla hay más ciclos vencidos que este número, los más antiguos ya no se crean. */
export const MAX_BACKLOG_CYCLES = MAX_ACCRUED_PERIODS;

export const AUTO_SOURCE = 'AUTOMATICO';

async function audit(
  db: Pick<Db, 'insert'>,
  action: string,
  resourceId: string | null,
  result: string,
  context: object = {},
) {
  await db.insert(auditLogs).values({
    actorAccountId: null,
    action,
    resource: 'prog_vac_cycle',
    resourceId,
    result,
    context,
  });
}

/** Números de ciclo (1-indexado) cuyo final ya se cumplió hoy, para una fecha de inicio de contrato. */
export function dueCycles(fIni: string, today: string): number[] {
  const out: number[] = [];
  for (let n = 1; ; n++) {
    if (addDays(fIni, n * CYCLE_DAYS) > today) break;
    out.push(n);
  }
  return out;
}

/** Fechas de inicio y fin (calendario) del ciclo N, 1-indexado. */
export function cycleRange(fIni: string, n: number): { perIni: string; perFin: string } {
  return {
    perIni: addDays(fIni, (n - 1) * CYCLE_DAYS),
    perFin: addDays(fIni, n * CYCLE_DAYS - 1),
  };
}

export interface CycleRunResult {
  contracts: number;
  created: number;
  expired: number;
}

/**
 * Genera automáticamente el período de vacaciones (15 días) del ciclo de 360 días que se cumplió, para
 * cada contrato vigente con fecha de inicio conocida. Un contrato con ciclos atrasados solo recibe, como
 * máximo, los `MAX_BACKLOG_CYCLES` más recientes que le falten; los anteriores no se crean (prescriben).
 * Si crear un ciclo dejaría más de `MAX_ACCRUED_PERIODS` períodos disponibles, el más antiguo de ellos
 * pasa a VENCIDA (sin días disponibles) para dejar sitio al nuevo. No requiere reautenticación: no hay un
 * actor humano, se ejecuta como tarea del sistema y queda auditado con `actorAccountId = null`.
 */
export async function runVacationCycles(db: Db, today: string): Promise<CycleRunResult> {
  if (!isValidIsoDate(today)) throw new Error('fecha inválida');
  const contracts = await db
    .select({
      nIde: employeeSnapshots.nIde,
      nCont: employeeSnapshots.nCont,
      fIni: employeeSnapshots.fIni,
    })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.est, 'V'), isNotNull(employeeSnapshots.fIni)));

  let created = 0;
  let expired = 0;
  for (const c of contracts) {
    const fIni = c.fIni;
    if (!fIni) continue;
    const due = dueCycles(fIni, today);
    if (due.length === 0) continue;

    const existing = await db
      .select({ perIni: progVac.perIni })
      .from(progVac)
      .where(and(eq(progVac.nIde, c.nIde), eq(progVac.nCont, c.nCont), eq(progVac.active, true)));
    const existingStarts = new Set(existing.map((e) => e.perIni));

    let missing = due.filter((n) => !existingStarts.has(cycleRange(fIni, n).perIni));
    if (missing.length > MAX_BACKLOG_CYCLES) missing = missing.slice(-MAX_BACKLOG_CYCLES);
    if (missing.length === 0) continue;

    for (const n of missing) {
      const { perIni, perFin } = cycleRange(fIni, n);
      await db.transaction(async (tx) => {
        // Bloquea el contrato para que dos ejecuciones concurrentes no dupliquen ni se pisen el tope.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`vacation-cycle:${c.nIde}:${c.nCont}`}))`,
        );
        const already = await tx
          .select({ id: progVac.id })
          .from(progVac)
          .where(
            and(
              eq(progVac.nIde, c.nIde),
              eq(progVac.nCont, c.nCont),
              eq(progVac.perIni, perIni),
              eq(progVac.active, true),
            ),
          );
        if (already.length > 0) return; // ya creado por una ejecución anterior o manualmente

        const accrued = await tx
          .select({
            id: progVac.id,
            perIni: progVac.perIni,
            dias: progVac.dias,
            disp: progVac.disp,
            version: progVac.version,
            createdAt: progVac.createdAt,
          })
          .from(progVac)
          .where(
            and(
              eq(progVac.nIde, c.nIde),
              eq(progVac.nCont, c.nCont),
              eq(progVac.active, true),
              eq(progVac.estado, 'ACTIVA'),
            ),
          )
          .orderBy(asc(progVac.perIni), asc(progVac.createdAt));
        if (accrued.length >= MAX_ACCRUED_PERIODS) {
          const oldest = accrued[0];
          if (oldest) {
            // Los días que se pierden quedan en el historial versionado del período, sin usuario (sistema).
            const version = oldest.version + 1;
            await tx.insert(progVacAdjustments).values({
              progVacId: oldest.id,
              actorAccountId: null,
              version,
              oldDias: oldest.dias,
              newDias: oldest.dias,
              oldDisp: oldest.disp,
              newDisp: 0,
              reason: `Vencido por el tope de ${MAX_ACCRUED_PERIODS} períodos acumulados al generarse el ciclo ${perIni} a ${perFin} (ciclo automático)`,
            });
            await tx
              .update(progVac)
              .set({ disp: 0, estado: 'VENCIDA', version, updatedAt: new Date() })
              .where(eq(progVac.id, oldest.id));
            await audit(tx, 'VACATION_CYCLE_EXPIRE', oldest.id, 'SUCCESS', {
              nIde: c.nIde,
              nCont: c.nCont,
              perIni: oldest.perIni,
            });
            expired++;
          }
        }
        const [row] = await tx
          .insert(progVac)
          .values({
            nIde: c.nIde,
            nCont: c.nCont,
            perIni,
            perFin,
            dias: CYCLE_VACATION_DAYS,
            disp: CYCLE_VACATION_DAYS,
            estado: 'ACTIVA',
            source: AUTO_SOURCE,
          })
          .returning({ id: progVac.id });
        await audit(tx, 'VACATION_CYCLE_CREATE', row?.id ?? null, 'SUCCESS', {
          nIde: c.nIde,
          nCont: c.nCont,
          perIni,
          perFin,
        });
        created++;
      });
    }
  }
  return { contracts: contracts.length, created, expired };
}
