import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { auditLogs, documentExports, employeeExitSchedules, employeeSnapshots } from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { getSettings } from './exit-settings.service';

const SUBJECT = '[NOMFLOW] Aviso de baja próxima';

@Injectable()
export class ExitNoticeService {
  private readonly log = new Logger('ExitNotice');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /** Bajas PENDIENTE cuya fecha prevista ya está dentro del plazo de aviso vigente. */
  async dueSchedules() {
    const settings = await getSettings(this.db);
    const today = new Date();
    const threshold = new Date(today.getTime() + settings.preBajaAvisoDias * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return this.db
      .select()
      .from(employeeExitSchedules)
      .where(
        and(
          eq(employeeExitSchedules.status, 'PENDIENTE'),
          lte(employeeExitSchedules.plannedDate, threshold),
        ),
      );
  }

  async sendNoticeAndRequestExport(
    schedule: typeof employeeExitSchedules.$inferSelect,
  ): Promise<void> {
    const [employee] = await this.db
      .select({ email: employeeSnapshots.email, nombre: employeeSnapshots.nombre })
      .from(employeeSnapshots)
      .where(eq(employeeSnapshots.id, schedule.employeeId));
    const settings = await getSettings(this.db);
    const body =
      `Le informamos que su vinculación tiene programada una fecha prevista de baja: ${schedule.plannedDate}.\n\n` +
      'A partir de este momento puede descargar una copia de sus documentos (volantes de pago, ' +
      'certificados tributarios y constancias de vacaciones aprobadas) desde NOMFLOW, en la sección ' +
      '"Mi baja". La descarga estará disponible por tiempo limitado una vez esté lista.';
    let noticeChannel = 'EMAIL';
    if (employee?.email) {
      try {
        await this.mailer.send(employee.email, SUBJECT, body);
      } catch (e) {
        this.log.error(`No se pudo enviar el aviso de baja: ${(e as Error).message}`);
        noticeChannel = 'EMAIL_FALLIDO';
      }
    } else {
      noticeChannel = 'SIN_CORREO';
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(employeeExitSchedules)
        .set({
          status: 'AVISADO',
          noticeSentAt: new Date(),
          noticeChannel,
          paramVersion: settings.updatedAt ? settings.updatedAt.toISOString() : null,
          updatedAt: new Date(),
        })
        .where(eq(employeeExitSchedules.id, schedule.id));
      const [exp] = await tx
        .insert(documentExports)
        .values({
          requestKind: 'AUTO_AVISO',
          nIde: schedule.nIde,
          employeeId: schedule.employeeId,
          exitScheduleId: schedule.id,
          status: 'PENDIENTE',
        })
        .returning({ id: documentExports.id });
      if (exp)
        await tx
          .update(employeeExitSchedules)
          .set({ exportId: exp.id })
          .where(eq(employeeExitSchedules.id, schedule.id));
      await tx.insert(auditLogs).values({
        actorAccountId: null,
        action: 'EXIT_NOTICE_SENT',
        resource: 'employee_exit_schedule',
        resourceId: schedule.id,
        result: noticeChannel === 'EMAIL' ? 'SUCCESS' : noticeChannel,
        context: { nIde: schedule.nIde, plannedDate: schedule.plannedDate },
      });
    });
  }

  async runOnce(): Promise<{ notified: number }> {
    const due = await this.dueSchedules();
    for (const schedule of due) await this.sendNoticeAndRequestExport(schedule);
    return { notified: due.length };
  }
}
