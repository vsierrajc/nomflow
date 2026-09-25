import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  accounts,
  auditLogs,
  notificationLog,
  notificationSettings,
  permitRequests,
  roleAssignments,
  vacationRequests,
} from '../db/schema';
import { MAILER, type Mailer } from '../mail/mailer';
import { nameOf, vacationDates } from './inbox.service';

export interface NotificationSettingsValues {
  notifyApprover: boolean;
  notifyEmployee: boolean;
  reminderDays: number;
  appUrl: string;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettingsValues = {
  notifyApprover: true,
  notifyEmployee: true,
  reminderDays: 3,
  appUrl: '',
};

export class NotificationSettingsError extends Error {
  constructor(readonly code: 'INVALID_SETTINGS') {
    super(code);
  }
}

export function validNotificationSettings(i: NotificationSettingsValues): boolean {
  let urlOk = i.appUrl === '';
  if (!urlOk) {
    try {
      const u = new URL(i.appUrl);
      urlOk = (u.protocol === 'https:' || u.protocol === 'http:') && i.appUrl.length <= 200;
    } catch {
      urlOk = false;
    }
  }
  return Number.isInteger(i.reminderDays) && i.reminderDays >= 0 && i.reminderDays <= 30 && urlOk;
}

type Category = 'NUEVA' | 'RESULTADO' | 'RECORDATORIO';
interface Line {
  recipient: string;
  category: Category;
  requestType: 'VACACION' | 'PERMISO';
  requestId: string;
  step: string;
  text: string;
}

const DAY = 86_400_000;
const RESULT_DAYS = 3;
const RETRY_MS = 5 * 60_000;
const range = (a: string | null, b: string | null) =>
  a && b ? `${a} a ${b}` : 'fechas por definir';

const SUBJECT: Record<Category, string> = {
  NUEVA: '[NOMFLOW] Tiene actividades pendientes en su bandeja',
  RESULTADO: '[NOMFLOW] Respuesta a su solicitud',
  RECORDATORIO: '[NOMFLOW] Recordatorio: actividades sin atender',
};
const INTRO: Record<Category, string> = {
  NUEVA: 'Tiene actividades pendientes en NOMFLOW:',
  RESULTADO: 'Hay una respuesta a su solicitud en NOMFLOW:',
  RECORDATORIO: 'Estas actividades siguen sin atender en NOMFLOW:',
};

@Injectable()
export class NotificationService {
  private readonly log = new Logger('Notifications');
  private running = false;
  /** Tras un fallo de envío no se reintenta al destinatario antes de este momento. */
  private readonly retryAt = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async getSettings(): Promise<NotificationSettingsValues> {
    const [s] = await this.db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.id, 1));
    if (!s) return { ...DEFAULT_NOTIFICATION_SETTINGS };
    return {
      notifyApprover: s.notifyApprover,
      notifyEmployee: s.notifyEmployee,
      reminderDays: s.reminderDays,
      appUrl: s.appUrl,
    };
  }

  async saveSettings(accountId: string, input: NotificationSettingsValues) {
    const values = { ...input, appUrl: input.appUrl.trim().replace(/\/+$/, '') };
    if (!validNotificationSettings(values)) throw new NotificationSettingsError('INVALID_SETTINGS');
    await this.db.transaction(async (tx) => {
      await tx
        .insert(notificationSettings)
        .values({ id: 1, ...values, updatedBy: accountId })
        .onConflictDoUpdate({
          target: notificationSettings.id,
          set: { ...values, updatedBy: accountId, updatedAt: new Date() },
        });
      await tx.insert(auditLogs).values({
        actorAccountId: accountId,
        action: 'NOTIFICATION_SETTINGS_UPDATE',
        resource: 'notification_settings',
        resourceId: '1',
        result: 'SUCCESS',
        context: values,
      });
    });
    return this.getSettings();
  }

  async history(limit = 50) {
    return this.db
      .select({
        id: notificationLog.id,
        kind: notificationLog.kind,
        requestType: notificationLog.requestType,
        sentAt: notificationLog.sentAt,
        recipient: accounts.email,
      })
      .from(notificationLog)
      .innerJoin(accounts, eq(accounts.id, notificationLog.recipientAccountId))
      .orderBy(desc(notificationLog.sentAt))
      .limit(limit);
  }

  /** Quiénes pueden dar la aprobación final en una empresa (cuentas activas con el rol vigente). */
  private async finalApprovers(cEmp: string): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.db
      .selectDistinct({ id: roleAssignments.accountId })
      .from(roleAssignments)
      .innerJoin(accounts, eq(accounts.id, roleAssignments.accountId))
      .where(
        and(
          eq(roleAssignments.role, 'VACATION_FINAL_APPROVER'),
          eq(roleAssignments.companyCode, cEmp),
          eq(accounts.status, 'ACTIVA'),
          lte(roleAssignments.validFrom, today),
          or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Todo lo que hoy amerita un aviso, sin decidir aún si ya se envió. */
  private async candidates(s: NotificationSettingsValues): Promise<Line[]> {
    const names = new Map<string, string>();
    const out: Line[] = [];
    const vac = await this.db
      .select()
      .from(vacationRequests)
      .where(
        or(
          inArray(vacationRequests.status, [
            'PENDIENTE_JEFE',
            'REVISION_EMPLEADO',
            'PENDIENTE_FINAL',
          ]),
          and(
            inArray(vacationRequests.status, ['APROBADA', 'RECHAZADA']),
            gte(vacationRequests.updatedAt, new Date(Date.now() - RESULT_DAYS * DAY)),
          ),
        ),
      );
    const dates = await vacationDates(this.db, vac);
    for (const r of vac) {
      const who = await nameOf(this.db, names, r.nIde, r.nCont);
      const d = dates.get(r.id) ?? '';
      const step = `${r.status}:${r.currentRevision}`;
      const base = { requestType: 'VACACION' as const, requestId: r.id, step };
      if (r.status === 'PENDIENTE_JEFE' && s.notifyApprover)
        out.push({
          ...base,
          recipient: r.managerAccountId,
          category: 'NUEVA',
          text: `Vacaciones de ${who} (${d}): esperan su decisión como jefe de área.`,
        });
      else if (r.status === 'PENDIENTE_FINAL' && s.notifyApprover)
        for (const a of await this.finalApprovers(r.cEmp))
          out.push({
            ...base,
            recipient: a,
            category: 'NUEVA',
            text: `Vacaciones de ${who} (${d}): esperan su aprobación final.`,
          });
      else if (r.status === 'REVISION_EMPLEADO' && s.notifyEmployee)
        out.push({
          ...base,
          recipient: r.accountId,
          category: 'NUEVA',
          text: `Su solicitud de vacaciones (${d}): el jefe propuso un cambio y espera su respuesta.`,
        });
      else if ((r.status === 'APROBADA' || r.status === 'RECHAZADA') && s.notifyEmployee)
        out.push({
          ...base,
          recipient: r.accountId,
          category: 'RESULTADO',
          text: `Su solicitud de vacaciones (${d}) fue ${r.status === 'APROBADA' ? 'aprobada' : 'rechazada'}.`,
        });
    }
    const per = await this.db
      .select()
      .from(permitRequests)
      .where(
        or(
          eq(permitRequests.status, 'PENDIENTE_JEFE'),
          and(
            inArray(permitRequests.status, ['APROBADO', 'RECHAZADO']),
            gte(permitRequests.updatedAt, new Date(Date.now() - RESULT_DAYS * DAY)),
          ),
        ),
      );
    for (const r of per) {
      const who = await nameOf(this.db, names, r.nIde, r.nCont);
      const d = `${r.typeName}, ${range(r.startDate, r.endDate)}`;
      const base = { requestType: 'PERMISO' as const, requestId: r.id, step: r.status };
      if (r.status === 'PENDIENTE_JEFE' && s.notifyApprover)
        out.push({
          ...base,
          recipient: r.managerAccountId,
          category: 'NUEVA',
          text: `Permiso de ${who} (${d}): espera su decisión como jefe de área.`,
        });
      else if ((r.status === 'APROBADO' || r.status === 'RECHAZADO') && s.notifyEmployee)
        out.push({
          ...base,
          recipient: r.accountId,
          category: 'RESULTADO',
          text: `Su solicitud de permiso (${d}) fue ${r.status === 'APROBADO' ? 'aprobada' : 'rechazada'}.`,
        });
    }
    return out;
  }

  /** Envía los avisos que faltan y los recordatorios vencidos. Un fallo de correo no detiene el resto. */
  async sweep(): Promise<{ sent: number; failed: number }> {
    if (this.running) return { sent: 0, failed: 0 };
    this.running = true;
    try {
      const s = await this.getSettings();
      const now = Date.now();
      const lines = await this.candidates(s);
      const ids = [...new Set(lines.map((l) => l.requestId))];
      const past =
        ids.length === 0
          ? []
          : await this.db
              .select()
              .from(notificationLog)
              .where(inArray(notificationLog.requestId, ids));
      const due: Line[] = [];
      for (const l of lines) {
        const last = past
          .filter(
            (p) =>
              p.requestId === l.requestId &&
              p.recipientAccountId === l.recipient &&
              p.step === l.step,
          )
          .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
        if (!last) due.push(l);
        else if (
          l.category === 'NUEVA' &&
          s.reminderDays > 0 &&
          now - last.sentAt.getTime() >= s.reminderDays * DAY
        )
          due.push({ ...l, category: 'RECORDATORIO' });
      }
      return await this.deliver(due, s, now);
    } finally {
      this.running = false;
    }
  }

  private async deliver(due: Line[], s: NotificationSettingsValues, now: number) {
    let sent = 0;
    let failed = 0;
    const groups = new Map<string, Line[]>();
    for (const l of due) {
      const k = `${l.recipient}|${l.category}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const [key, group] of groups) {
      const first = group[0];
      if (!first) continue;
      if ((this.retryAt.get(key) ?? 0) > now) continue;
      const [acct] = await this.db
        .select({ email: accounts.email, status: accounts.status })
        .from(accounts)
        .where(eq(accounts.id, first.recipient));
      // A quien aún no activó su cuenta no se le escribe: lo recibirá al activarla.
      if (!acct || acct.status !== 'ACTIVA') continue;
      const link = s.appUrl
        ? `\n\nAbra su bandeja: ${s.appUrl}/bandeja`
        : '\n\nIngrese a NOMFLOW y abra la Bandeja de entrada.';
      const body = `${INTRO[first.category]}\n\n${group.map((g) => `- ${g.text}`).join('\n')}${link}`;
      try {
        await this.mailer.send(acct.email, SUBJECT[first.category], body);
        await this.db.insert(notificationLog).values(
          group.map((g) => ({
            kind: g.category,
            requestType: g.requestType,
            requestId: g.requestId,
            step: g.step,
            recipientAccountId: g.recipient,
          })),
        );
        this.retryAt.delete(key);
        sent += 1;
      } catch (e) {
        failed += 1;
        this.retryAt.set(key, now + RETRY_MS);
        this.log.error(`No se pudo enviar el aviso: ${(e as Error).message}`);
      }
    }
    return { sent, failed };
  }
}
