import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, employeeExitSchedules } from '../db/schema';

/**
 * Al aplicar EST = C se llama aquí, tanto desde la importación como desde el cambio manual.
 * Si hubo un aviso ya enviado (AVISADO), lo cierra como EJECUTADO. Si no hubo aviso -o solo
 * quedó en PENDIENTE, nunca enviado- registra el incumplimiento sin bloquear la revocación,
 * que ya ocurre de todas formas (SSD 3.1, 6.3).
 */
export async function checkExitNoticeCompliance(
  db: Db,
  actorId: string,
  nIde: string,
): Promise<void> {
  const rows = await db
    .select()
    .from(employeeExitSchedules)
    .where(
      and(
        eq(employeeExitSchedules.nIde, nIde),
        inArray(employeeExitSchedules.status, ['PENDIENTE', 'AVISADO']),
      ),
    );
  const notified = rows.find((r) => r.status === 'AVISADO');
  if (notified) {
    await db
      .update(employeeExitSchedules)
      .set({ status: 'EJECUTADO', updatedAt: new Date() })
      .where(eq(employeeExitSchedules.id, notified.id));
    return;
  }
  await db.insert(auditLogs).values({
    actorAccountId: actorId,
    action: 'EXIT_NO_NOTICE_INCUMPLIMIENTO',
    resource: 'employee_exit_schedule',
    resourceId: rows[0]?.id ?? null,
    result: 'INCUMPLIMIENTO',
    context: { nIde, plannedDate: rows[0]?.plannedDate ?? null },
  });
}
