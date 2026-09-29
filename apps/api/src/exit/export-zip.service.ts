import { createHash } from 'node:crypto';
import archiver from 'archiver';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  auditLogs,
  certificateRequests,
  documentExports,
  employeeSnapshots,
  payrollLines,
  taxCertificates,
  vacationDocuments,
  vacationRequests,
} from '../db/schema';
import { adminDownloadVoucher, adminListVouchers } from '../payroll/voucher.service';
import type { ObjectStore } from '../storage/object-store';
import { getSettings } from './exit-settings.service';

const AUTO_REASON = 'Exportación de baja ESS-EXIT-001';

export interface ManifestEntry {
  type:
    | 'VOLANTE'
    | 'CERTIFICADO_TRIBUTARIO'
    | 'CERTIFICADO_LABORAL'
    | 'VACACIONES'
    | 'CONTRATO_HISTORICO';
  fileName: string;
  ref: string;
  sizeBytes: number;
}

interface Collected {
  entries: ManifestEntry[];
  files: { fileName: string; data: Buffer }[];
  missing: string[];
}

async function collect(db: Db, store: ObjectStore, nIde: string): Promise<Collected> {
  const entries: ManifestEntry[] = [];
  const files: { fileName: string; data: Buffer }[] = [];
  const missing: string[] = [];

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.nIde, nIde))
    .limit(1);

  // Volantes publicados
  const anyPayroll = await db
    .select({ id: payrollLines.id })
    .from(payrollLines)
    .where(eq(payrollLines.nIde, nIde))
    .limit(1);
  if (account) {
    const vouchers = await adminListVouchers(db, account.id, nIde);
    if (vouchers.length === 0 && anyPayroll.length > 0) missing.push('VOLANTES');
    for (const v of vouchers) {
      try {
        const { pdf, fileName } = await adminDownloadVoucher(
          db,
          account.id,
          nIde,
          v,
          'SIN_AJUSTE',
          AUTO_REASON,
        );
        entries.push({
          type: 'VOLANTE',
          fileName,
          ref: `${v.per}-${v.nLiq}-${v.contrato}`,
          sizeBytes: pdf.length,
        });
        files.push({ fileName: `volantes/${fileName}`, data: pdf });
      } catch {
        missing.push(`VOLANTE_${v.per}_${v.nLiq}`);
      }
    }
  } else if (anyPayroll.length > 0) {
    missing.push('VOLANTES');
  }

  // Certificados tributarios activos
  const taxRows = await db
    .select()
    .from(taxCertificates)
    .where(and(eq(taxCertificates.nIde, nIde), eq(taxCertificates.active, true)));
  for (const r of taxRows) {
    const data = r.objectKey ? await store.get(r.objectKey) : r.data;
    if (!data) {
      missing.push(`CERTIFICADO_TRIBUTARIO_${r.year}`);
      continue;
    }
    const fileName = `certificado-tributario-${r.year}.pdf`;
    entries.push({
      type: 'CERTIFICADO_TRIBUTARIO',
      fileName,
      ref: String(r.year),
      sizeBytes: data.length,
    });
    files.push({ fileName: `certificados-tributarios/${fileName}`, data });
  }

  // Certificados laborales emitidos
  const laborRows = await db
    .select()
    .from(certificateRequests)
    .where(eq(certificateRequests.nIde, nIde))
    .orderBy(desc(certificateRequests.createdAt));
  for (const r of laborRows) {
    const data = await store.get(r.objectKey);
    if (!data) {
      missing.push(`CERTIFICADO_LABORAL_${r.id}`);
      continue;
    }
    const fileName = `certificado-laboral-${r.id.slice(0, 8)}.pdf`;
    entries.push({ type: 'CERTIFICADO_LABORAL', fileName, ref: r.id, sizeBytes: data.length });
    files.push({ fileName: `certificados-laborales/${fileName}`, data });
  }

  // Constancias de vacaciones aprobadas
  const vacRows = await db
    .select({ doc: vacationDocuments, requestId: vacationRequests.id })
    .from(vacationRequests)
    .innerJoin(vacationDocuments, eq(vacationDocuments.requestId, vacationRequests.id))
    .where(and(eq(vacationRequests.nIde, nIde), eq(vacationRequests.status, 'APROBADA')));
  for (const { doc } of vacRows) {
    const data = await store.get(doc.objectKey);
    if (!data) {
      missing.push(`VACACIONES_${doc.id}`);
      continue;
    }
    const fileName = `vacaciones-${doc.id.slice(0, 8)}.pdf`;
    entries.push({ type: 'VACACIONES', fileName, ref: doc.id, sizeBytes: data.length });
    files.push({ fileName: `vacaciones/${fileName}`, data });
  }

  // Metadatos de contratos históricos (todas las instantáneas, no solo la activa)
  const snapshots = await db
    .select()
    .from(employeeSnapshots)
    .where(eq(employeeSnapshots.nIde, nIde))
    .orderBy(desc(employeeSnapshots.version));
  const history = Buffer.from(JSON.stringify(snapshots, null, 2), 'utf8');
  entries.push({
    type: 'CONTRATO_HISTORICO',
    fileName: 'contratos.json',
    ref: nIde,
    sizeBytes: history.length,
  });
  files.push({ fileName: 'contratos.json', data: history });

  return { entries, files, missing };
}

function zipBuffer(files: { fileName: string; data: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const f of files) archive.append(f.data, { name: f.fileName });
    void archive.finalize();
  });
}

export async function assembleZip(db: Db, store: ObjectStore, exportId: string): Promise<void> {
  const [exp] = await db.select().from(documentExports).where(eq(documentExports.id, exportId));
  if (!exp || exp.status !== 'PENDIENTE') return;
  await db
    .update(documentExports)
    .set({ status: 'GENERANDO' })
    .where(eq(documentExports.id, exportId));
  try {
    const { entries, files, missing } = await collect(db, store, exp.nIde);
    const zip = await zipBuffer(files);
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const objectKey = `exit-exports/${exportId}.zip`;
    await store.put(objectKey, zip, 'application/zip');
    const readyAt = new Date();
    const settings = await getSettings(db);
    const expiresAt = new Date(readyAt.getTime() + settings.zipExpiryDays * 86_400_000);
    const status = missing.length > 0 ? 'INCOMPLETO' : 'LISTO';
    await db
      .update(documentExports)
      .set({
        status,
        manifest: entries,
        missingReport: missing.length > 0 ? missing : null,
        objectKey,
        sha256,
        sizeBytes: zip.length,
        readyAt,
        expiresAt,
      })
      .where(eq(documentExports.id, exportId));
    await db.insert(auditLogs).values({
      actorAccountId: exp.requestedBy,
      action: status === 'LISTO' ? 'EXIT_EXPORT_READY' : 'EXIT_EXPORT_INCOMPLETE',
      resource: 'document_export',
      resourceId: exportId,
      result: status,
      context: { nIde: exp.nIde, missing },
    });
  } catch (e) {
    await db
      .update(documentExports)
      .set({ status: 'ERROR', errorDetail: (e as Error).message })
      .where(eq(documentExports.id, exportId));
    await db.insert(auditLogs).values({
      actorAccountId: exp.requestedBy,
      action: 'EXIT_EXPORT_ERROR',
      resource: 'document_export',
      resourceId: exportId,
      result: 'ERROR',
      context: { nIde: exp.nIde, message: (e as Error).message },
    });
  }
}

export async function pendingExports(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: documentExports.id })
    .from(documentExports)
    .where(eq(documentExports.status, 'PENDIENTE'));
  return rows.map((r) => r.id);
}
