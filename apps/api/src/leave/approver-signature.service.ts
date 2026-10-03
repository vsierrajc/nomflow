import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hasActiveRole, type RoleName } from '../auth/roles';
import type { Db } from '../db/client';
import { approverSignatures, auditLogs } from '../db/schema';
import { inspectImage } from '../org/logos.service';

export type ApproverSignatureErrorCode =
  'NOT_APPROVER' | 'CONSENT_REQUIRED' | 'TOO_LARGE' | 'INVALID_IMAGE' | 'NOT_FOUND';

export class ApproverSignatureError extends Error {
  constructor(readonly code: ApproverSignatureErrorCode) {
    super(code);
  }
}

/** Quienes pueden decidir solicitudes de vacaciones y, por tanto, firmar la constancia. */
export const APPROVER_ROLE_NAMES: readonly RoleName[] = [
  'AREA_MANAGER',
  'AREA_DIRECTOR',
  'GENERAL_MANAGER',
  'VACATION_FINAL_APPROVER',
];

export const MAX_APPROVER_SIGNATURE_BYTES = 300 * 1024;
const MIN_SIDE = 100;
const MAX_SIDE = 2000;

async function audit(db: Db, actor: string, action: string, result: string, context: object = {}) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'approver_signature',
    resourceId: actor,
    result,
    context,
  });
}

/** Estado de la firma propia (nunca la imagen): si puede cargarla, si ya lo hizo y cuándo autorizó. */
export async function myApproverSignature(db: Db, accountId: string) {
  const eligible = await hasActiveRole(db, accountId, APPROVER_ROLE_NAMES);
  const [s] = await db
    .select({ consentAt: approverSignatures.consentAt, sha256: approverSignatures.sha256 })
    .from(approverSignatures)
    .where(eq(approverSignatures.accountId, accountId));
  return {
    eligible,
    enrolled: Boolean(s),
    consentAt: s?.consentAt ?? null,
    sha256: s?.sha256 ?? null,
  };
}

/** La persona carga su firma y autoriza su uso en las constancias; reemplaza la anterior. */
export async function enrollApproverSignature(
  db: Db,
  accountId: string,
  file: Buffer,
  consent: boolean,
) {
  const fail = async (code: ApproverSignatureErrorCode): Promise<never> => {
    await audit(db, accountId, 'APPROVER_SIGNATURE_ENROLL', code);
    throw new ApproverSignatureError(code);
  };
  if (!(await hasActiveRole(db, accountId, APPROVER_ROLE_NAMES))) return fail('NOT_APPROVER');
  if (!consent) return fail('CONSENT_REQUIRED');
  if (file.length > MAX_APPROVER_SIGNATURE_BYTES) return fail('TOO_LARGE');
  const info = inspectImage(file);
  if (
    !info ||
    info.width < MIN_SIDE ||
    info.height < MIN_SIDE ||
    info.width > MAX_SIDE ||
    info.height > MAX_SIDE
  )
    return fail('INVALID_IMAGE');
  const sha256 = createHash('sha256').update(file).digest('hex');
  const values = {
    signature: file,
    contentType: info.contentType,
    sha256,
    consentAt: new Date(),
    updatedAt: new Date(),
  };
  await db
    .insert(approverSignatures)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: approverSignatures.accountId, set: values });
  await audit(db, accountId, 'APPROVER_SIGNATURE_ENROLL', 'SUCCESS', { sha256 });
}

/** La persona retira su firma: las constancias futuras salen sin ella (las ya emitidas no cambian). */
export async function removeApproverSignature(db: Db, accountId: string) {
  const gone = await db
    .delete(approverSignatures)
    .where(eq(approverSignatures.accountId, accountId))
    .returning({ id: approverSignatures.id });
  if (gone.length === 0) throw new ApproverSignatureError('NOT_FOUND');
  await audit(db, accountId, 'APPROVER_SIGNATURE_REMOVE', 'SUCCESS');
}

/** La imagen la ve solo su titular. */
export async function ownApproverSignatureImage(db: Db, accountId: string) {
  const [s] = await db
    .select({ data: approverSignatures.signature, type: approverSignatures.contentType })
    .from(approverSignatures)
    .where(eq(approverSignatures.accountId, accountId));
  if (!s) throw new ApproverSignatureError('NOT_FOUND');
  return { data: s.data, contentType: s.type };
}

/** Para la constancia: la firma autorizada de una persona, o nulo si no la cargó. */
export async function signatureForDocument(db: Db, accountId: string) {
  const [s] = await db
    .select({ data: approverSignatures.signature, sha256: approverSignatures.sha256 })
    .from(approverSignatures)
    .where(eq(approverSignatures.accountId, accountId));
  return s ? { data: s.data, sha256: s.sha256 } : null;
}
