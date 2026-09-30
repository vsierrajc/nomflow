import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  auditLogs,
  dataRetentionSettings,
  documentExportDownloads,
  documentExports,
  employeeSnapshots,
  importBatchRows,
  importBatches,
  sessions,
  taxCertificates,
  verificationCodes,
} from '../db/schema';
import { OBJECT_STORE, type DeletableObjectStore } from '../storage/object-store';

const DAY = 86_400_000;

export type DataRetentionErrorCode = 'INVALID' | 'EMPLOYEE_ACTIVE' | 'NOT_CONFIRMED' | 'NOT_FOUND';
export class DataRetentionError extends Error {
  constructor(readonly code: DataRetentionErrorCode) {
    super(code);
  }
}

export interface DataRetentionValues {
  sessionsRetentionDays: number;
  verificationCodesRetentionDays: number;
  importStagingRetentionDays: number;
  autoEnabled: boolean;
}
export const DEFAULT_DATA_RETENTION: DataRetentionValues = {
  sessionsRetentionDays: 30,
  verificationCodesRetentionDays: 30,
  importStagingRetentionDays: 90,
  autoEnabled: false,
};

export function validDataRetention(s: DataRetentionValues): boolean {
  const int = (v: number) => Number.isInteger(v) && v >= 1 && v <= 3650;
  return (
    int(s.sessionsRetentionDays) &&
    int(s.verificationCodesRetentionDays) &&
    int(s.importStagingRetentionDays)
  );
}

/**
 * Depuración de datos operativos que ya cumplieron su ciclo (SSD 12): sesiones vencidas o
 * revocadas, códigos de verificación usados o vencidos, filas de preparación de importaciones ya
 * aplicadas o fallidas, y ZIP de baja caducados (con su objeto en el almacén). No toca los
 * certificados de retención: su plazo legal aún no está definido.
 */
@Injectable()
export class DataRetentionService {
  private readonly log = new Logger('DataRetention');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: DeletableObjectStore,
  ) {}

  async getSettings(): Promise<
    DataRetentionValues & {
      lastRunAt: Date | null;
      lastRunStatus: string | null;
      lastRunSummary: string | null;
    }
  > {
    const [s] = await this.db
      .select()
      .from(dataRetentionSettings)
      .where(eq(dataRetentionSettings.id, 1));
    return {
      ...(s
        ? {
            sessionsRetentionDays: s.sessionsRetentionDays,
            verificationCodesRetentionDays: s.verificationCodesRetentionDays,
            importStagingRetentionDays: s.importStagingRetentionDays,
            autoEnabled: s.autoEnabled,
          }
        : DEFAULT_DATA_RETENTION),
      lastRunAt: s?.lastRunAt ?? null,
      lastRunStatus: s?.lastRunStatus ?? null,
      lastRunSummary: s?.lastRunSummary ?? null,
    };
  }

  async saveSettings(actor: string, input: DataRetentionValues) {
    if (!validDataRetention(input)) throw new DataRetentionError('INVALID');
    await this.db.transaction(async (tx) => {
      await tx
        .insert(dataRetentionSettings)
        .values({ id: 1, ...input, updatedBy: actor })
        .onConflictDoUpdate({
          target: dataRetentionSettings.id,
          set: { ...input, updatedBy: actor, updatedAt: new Date() },
        });
      await tx.insert(auditLogs).values({
        actorAccountId: actor,
        action: 'DATA_RETENTION_SETTINGS_UPDATE',
        resource: 'data_retention_settings',
        resourceId: '1',
        result: 'SUCCESS',
        context: input,
      });
    });
    return this.getSettings();
  }

  /** Cuántas filas son candidatas a depurarse ya mismo, con la política vigente (sin borrar nada). */
  async preview(): Promise<{
    sessions: number;
    verificationCodes: number;
    importRows: number;
    exports: number;
  }> {
    const s = await this.getSettings();
    const now = Date.now();
    const cut = (days: number) => new Date(now - days * DAY);

    const [sessionsCount] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        lt(
          sql`coalesce(${sessions.revokedAt}, ${sessions.expiresAt})`,
          cut(s.sessionsRetentionDays),
        ),
      );

    const [codesCount] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(verificationCodes)
      .where(
        lt(
          sql`coalesce(${verificationCodes.usedAt}, ${verificationCodes.expiresAt})`,
          cut(s.verificationCodesRetentionDays),
        ),
      );

    const terminalBatchIds = await this.terminalBatchIds(cut(s.importStagingRetentionDays));
    const [rowsCount] = terminalBatchIds.length
      ? await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(importBatchRows)
          .where(inArray(importBatchRows.batchId, terminalBatchIds))
      : [{ n: 0 }];

    const [exportsCount] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(documentExports)
      .where(lt(documentExports.expiresAt, new Date(now)));

    return {
      sessions: sessionsCount?.n ?? 0,
      verificationCodes: codesCount?.n ?? 0,
      importRows: rowsCount?.n ?? 0,
      exports: exportsCount?.n ?? 0,
    };
  }

  private async terminalBatchIds(before: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(
        and(
          inArray(importBatches.status, ['APLICADO', 'FALLIDO']),
          lt(sql`coalesce(${importBatches.appliedAt}, ${importBatches.createdAt})`, before),
        ),
      );
    return rows.map((r) => r.id);
  }

  // ---------- mantenimiento según la política ----------
  async runMaintenance(actor: string | null): Promise<{
    sessions: number;
    verificationCodes: number;
    importRows: number;
    exports: number;
  }> {
    const s = await this.getSettings();
    const now = Date.now();
    const cut = (days: number) => new Date(now - days * DAY);

    const purgedSessions = await this.db
      .delete(sessions)
      .where(
        lt(
          sql`coalesce(${sessions.revokedAt}, ${sessions.expiresAt})`,
          cut(s.sessionsRetentionDays),
        ),
      )
      .returning({ id: sessions.id });

    const purgedCodes = await this.db
      .delete(verificationCodes)
      .where(
        lt(
          sql`coalesce(${verificationCodes.usedAt}, ${verificationCodes.expiresAt})`,
          cut(s.verificationCodesRetentionDays),
        ),
      )
      .returning({ id: verificationCodes.id });

    const terminalBatchIds = await this.terminalBatchIds(cut(s.importStagingRetentionDays));
    const purgedRows = terminalBatchIds.length
      ? await this.db
          .delete(importBatchRows)
          .where(inArray(importBatchRows.batchId, terminalBatchIds))
          .returning({ batchId: importBatchRows.batchId })
      : [];

    const expiredExports = await this.db
      .select()
      .from(documentExports)
      .where(lt(documentExports.expiresAt, new Date(now)));
    for (const exp of expiredExports) {
      if (exp.objectKey) {
        try {
          await this.store.delete(exp.objectKey);
        } catch (e) {
          this.log.error(`No se pudo borrar el ZIP ${exp.objectKey}: ${(e as Error).message}`);
          continue; // no borrar la fila si el objeto sigue ahí: se reintenta en la próxima corrida
        }
      }
      await this.db
        .delete(documentExportDownloads)
        .where(eq(documentExportDownloads.exportId, exp.id));
      await this.db.delete(documentExports).where(eq(documentExports.id, exp.id));
    }

    const result = {
      sessions: purgedSessions.length,
      verificationCodes: purgedCodes.length,
      importRows: purgedRows.length,
      exports: expiredExports.length,
    };

    if (actor) {
      await this.db.insert(auditLogs).values({
        actorAccountId: actor,
        action: 'DATA_RETENTION_PURGE',
        resource: 'data_retention',
        result: 'SUCCESS',
        context: result,
      });
    }
    return result;
  }

  /** Estado de los certificados de retención de una persona: solo se pueden borrar con la baja efectiva. */
  async certificatesStatus(nIde: string) {
    const snaps = await this.db
      .select({ est: employeeSnapshots.est })
      .from(employeeSnapshots)
      .where(eq(employeeSnapshots.nIde, nIde));
    const [certs] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(taxCertificates)
      .where(eq(taxCertificates.nIde, nIde));
    const [zip] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(documentExportDownloads)
      .innerJoin(documentExports, eq(documentExports.id, documentExportDownloads.exportId))
      .where(eq(documentExports.nIde, nIde));
    return {
      nIde,
      employeeActive: snaps.some((r) => r.est === 'V'),
      known: snaps.length > 0,
      certificates: certs?.n ?? 0,
      zipDownloads: zip?.n ?? 0,
    };
  }

  /**
   * Borrado manual (nunca automático) de los certificados de retención de un empleado dado de baja.
   * Exige repetir el número de identificación como confirmación y deja auditoría.
   */
  async deleteCertificates(actor: string, nIde: string, confirmNIde: string) {
    const st = await this.certificatesStatus(nIde);
    if (!st.known) throw new DataRetentionError('NOT_FOUND');
    if (st.employeeActive) throw new DataRetentionError('EMPLOYEE_ACTIVE');
    if (confirmNIde !== nIde) throw new DataRetentionError('NOT_CONFIRMED');
    const rows = await this.db
      .select({ id: taxCertificates.id, objectKey: taxCertificates.objectKey })
      .from(taxCertificates)
      .where(eq(taxCertificates.nIde, nIde));
    for (const r of rows) if (r.objectKey) await this.store.delete(r.objectKey);
    if (rows.length > 0) {
      await this.db.delete(taxCertificates).where(eq(taxCertificates.nIde, nIde));
    }
    await this.db.insert(auditLogs).values({
      actorAccountId: actor,
      action: 'TAX_CERTIFICATES_DELETE',
      resource: 'tax_certificates',
      resourceId: nIde,
      result: 'SUCCESS',
      context: { deleted: rows.length, zipDownloads: st.zipDownloads },
    });
    return { deleted: rows.length, zipDownloads: st.zipDownloads };
  }

  async recordRun(status: 'OK' | 'ERROR', summary: string) {
    await this.db
      .insert(dataRetentionSettings)
      .values({
        id: 1,
        lastRunAt: new Date(),
        lastRunStatus: status,
        lastRunSummary: summary.slice(0, 500),
      })
      .onConflictDoUpdate({
        target: dataRetentionSettings.id,
        set: {
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunSummary: summary.slice(0, 500),
        },
      });
  }
}
