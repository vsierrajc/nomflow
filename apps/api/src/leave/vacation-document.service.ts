import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  auditLogs,
  companies,
  employeeSnapshots,
  progVac,
  vacationActions,
  vacationDocuments,
  vacationRequests,
  vacationRevisionAllocations,
  vacationRevisions,
} from '../db/schema';
import { logoForCompanyCode } from '../org/logos.service';
import { ObjectStoreError, type ObjectStore } from '../storage/object-store';
import { renderVacationPdf, type VacationDocData } from './vacation-document.pdf';
import { VacationError, loadViewable } from './vacation.service';

const ACTION_LABEL: Record<string, string> = {
  ENVIAR: 'Solicitud enviada y fechas aceptadas por el empleado',
  ACEPTAR: 'Cambio propuesto aceptado por el empleado',
  PROPONER: 'Cambio propuesto por el jefe de área',
  APROBAR_JEFE: 'Aprobada por el jefe de área',
  APROBAR_FINAL: 'Aprobación final',
};

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function audit(db: Db, actor: string | null, action: string, id: string, result: string) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'vacation_document',
    resourceId: id,
    result,
  });
}

/** Reúne lo que va en la constancia. Solo existe para solicitudes aprobadas. */
async function buildData(db: Db, requestId: string): Promise<VacationDocData | null> {
  const [req] = await db.select().from(vacationRequests).where(eq(vacationRequests.id, requestId));
  if (!req || req.status !== 'APROBADA') return null;
  const [rev] = await db
    .select()
    .from(vacationRevisions)
    .where(
      and(
        eq(vacationRevisions.requestId, requestId),
        eq(vacationRevisions.number, req.currentRevision),
      ),
    );
  if (!rev) return null;
  const allocations = await db
    .select({
      perIni: progVac.perIni,
      perFin: progVac.perFin,
      days: vacationRevisionAllocations.days,
    })
    .from(vacationRevisionAllocations)
    .innerJoin(progVac, eq(progVac.id, vacationRevisionAllocations.progVacId))
    .where(eq(vacationRevisionAllocations.revisionId, rev.id))
    .orderBy(progVac.perIni);
  const actions = await db
    .select({
      action: vacationActions.action,
      at: vacationActions.at,
      revision: vacationActions.revisionNumber,
      comment: vacationActions.comment,
      nIde: accounts.nIde,
    })
    .from(vacationActions)
    .innerJoin(accounts, eq(accounts.id, vacationActions.actorAccountId))
    .where(eq(vacationActions.requestId, requestId))
    .orderBy(vacationActions.at);
  const nameOf = new Map<string, string>();
  for (const nIde of new Set([req.nIde, ...actions.map((a) => a.nIde)])) {
    const [e] = await db
      .select({ nombre: employeeSnapshots.nombre })
      .from(employeeSnapshots)
      .where(eq(employeeSnapshots.nIde, nIde))
      .orderBy(sql`case when ${employeeSnapshots.est} = 'V' then 0 else 1 end`)
      .limit(1);
    nameOf.set(nIde, e?.nombre ?? nIde);
  }
  const [company] = await db.select().from(companies).where(eq(companies.cEmp, req.cEmp));
  const finalAction = actions.filter((a) => a.action === 'APROBAR_FINAL').at(-1);
  return {
    requestId,
    revision: rev.number,
    contentHash: rev.contentHash,
    employee: { name: nameOf.get(req.nIde) ?? req.nIde, nIde: req.nIde, nCont: req.nCont },
    company: company
      ? { nombre: company.nombre, sigla: company.sigla, direccion: company.direccion }
      : null,
    logo: await logoForCompanyCode(db, req.cEmp),
    start: rev.startDate,
    end: rev.endDate,
    calendarDiff: rev.calendarDiff,
    businessDays: rev.businessDays,
    returnDate: rev.returnDate,
    allocations,
    actions: actions
      .filter((a) => ACTION_LABEL[a.action])
      .map((a) => ({
        label: ACTION_LABEL[a.action] ?? a.action,
        name: nameOf.get(a.nIde) ?? a.nIde,
        at: a.at,
        revision: a.revision,
        comment: a.comment,
      })),
    approvedAt: finalAction?.at ?? req.updatedAt,
  };
}

/**
 * Deja guardada la constancia de una solicitud aprobada (una sola vez, nunca se sobrescribe).
 * Se genera al aprobar y, si eso falló, al primer intento de descarga. Un candado por solicitud
 * evita que dos peticiones simultáneas generen dos versiones con huellas distintas.
 */
export async function ensureVacationDocument(db: Db, store: ObjectStore, requestId: string) {
  const [existing] = await db
    .select()
    .from(vacationDocuments)
    .where(eq(vacationDocuments.requestId, requestId));
  if (existing) return existing;
  const data = await buildData(db, requestId);
  if (!data) return null;
  const pdf = await renderVacationPdf(data);
  const objectKey = `vacation-requests/${requestId}/rev-${data.revision}.pdf`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`vacation-doc:${requestId}`}))`);
    const [again] = await tx
      .select()
      .from(vacationDocuments)
      .where(eq(vacationDocuments.requestId, requestId));
    if (again) return again;
    await store.put(objectKey, pdf, 'application/pdf');
    const [row] = await tx
      .insert(vacationDocuments)
      .values({
        requestId,
        revisionNumber: data.revision,
        objectKey,
        sha256: sha256(pdf),
        sizeBytes: pdf.length,
      })
      .returning();
    return row ?? null;
  });
}

/** Después de la aprobación final: no debe hacer fallar la aprobación, que ya quedó confirmada. */
export async function tryEnsureVacationDocument(db: Db, store: ObjectStore, requestId: string) {
  try {
    await ensureVacationDocument(db, store, requestId);
    await audit(db, null, 'VACATION_DOCUMENT_GENERATE', requestId, 'SUCCESS');
  } catch (e) {
    await audit(
      db,
      null,
      'VACATION_DOCUMENT_GENERATE',
      requestId,
      e instanceof ObjectStoreError ? e.code : 'ERROR',
    );
  }
}

/** Descarga: solo quien puede ver la solicitud; se comprueba la huella contra la guardada. */
export async function getVacationDocument(
  db: Db,
  store: ObjectStore,
  viewerId: string,
  requestId: string,
): Promise<{ data: Buffer; fileName: string }> {
  const { req } = await loadViewable(db, viewerId, requestId);
  if (req.status !== 'APROBADA') throw new VacationError('NOT_FOUND'); // solo hay constancia si se aprobó
  const doc = await ensureVacationDocument(db, store, requestId);
  if (!doc) throw new VacationError('NOT_FOUND');
  let data: Buffer | null;
  try {
    data = await store.get(doc.objectKey);
  } catch (e) {
    await audit(
      db,
      viewerId,
      'VACATION_DOCUMENT_DOWNLOAD',
      requestId,
      e instanceof ObjectStoreError ? e.code : 'ERROR',
    );
    throw e;
  }
  if (!data) {
    await audit(db, viewerId, 'VACATION_DOCUMENT_DOWNLOAD', requestId, 'OBJECT_MISSING');
    throw new ObjectStoreError('INTEGRITY');
  }
  if (sha256(data) !== doc.sha256) {
    await audit(db, viewerId, 'VACATION_DOCUMENT_DOWNLOAD', requestId, 'HASH_MISMATCH');
    throw new ObjectStoreError('INTEGRITY');
  }
  await audit(db, viewerId, 'VACATION_DOCUMENT_DOWNLOAD', requestId, 'OK');
  return { data, fileName: `constancia-vacaciones-${requestId.slice(0, 8)}.pdf` };
}
