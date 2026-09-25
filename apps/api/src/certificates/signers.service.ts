import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  auditLogs,
  certificateSigners,
  companies,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { inspectImage } from '../org/logos.service';
import { open, seal } from '../security/secret-box';
import { DigitalSignatureError, generateSelfSigned, inspectP12 } from './digital-signature';

export type SignerErrorCode =
  | 'NOT_FOUND'
  | 'ACCOUNT_NOT_FOUND'
  | 'COMPANY_NOT_FOUND'
  | 'INVALID_SIGNER'
  | 'ALREADY_SIGNER'
  | 'NOT_A_SIGNER'
  | 'INVALID_IMAGE'
  | 'TOO_LARGE'
  | 'CONSENT_REQUIRED'
  | 'INVALID_P12'
  | 'WRONG_PASSPHRASE'
  | 'EXPIRED_CERT'
  | 'WEAK_KEY'
  | 'NO_DIGITAL';

export class SignerError extends Error {
  constructor(readonly code: SignerErrorCode) {
    super(code);
  }
}

export const MAX_SIGNATURE_BYTES = 300 * 1024;
const MIN_SIDE = 100;
const MAX_SIDE = 2000;
export type Tier = 'PRINCIPAL' | 'RESPALDO';

async function audit(
  db: Db,
  actor: string,
  action: string,
  resourceId: string | null,
  result: string,
  context: object = {},
) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'certificate_signer',
    resourceId,
    result,
    context,
  });
}

const today = () => new Date().toISOString().slice(0, 10);

/** El rol vigente de firmante (CERTIFICATE_APPROVER) de la empresa, que acompaña a cada firmante. */
async function hasSignerRole(db: Db, accountId: string, cEmp: string): Promise<boolean> {
  const t = today();
  const rows = await db
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.accountId, accountId),
        eq(roleAssignments.role, 'CERTIFICATE_APPROVER'),
        eq(roleAssignments.companyCode, cEmp),
        lte(roleAssignments.validFrom, t),
        or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, t)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function listSigners(db: Db, cEmp: string) {
  const rows = await db
    .select({
      id: certificateSigners.id,
      accountId: certificateSigners.accountId,
      title: certificateSigners.title,
      tier: certificateSigners.tier,
      active: certificateSigners.active,
      hasSignature: certificateSigners.signature,
      consentAt: certificateSigners.consentAt,
      digitalEnc: certificateSigners.digitalEnc,
      digitalSubject: certificateSigners.digitalSubject,
      digitalNotAfter: certificateSigners.digitalNotAfter,
      digitalOrigin: certificateSigners.digitalOrigin,
      digitalConsentAt: certificateSigners.digitalConsentAt,
      email: accounts.email,
      status: accounts.status,
      nIde: accounts.nIde,
    })
    .from(certificateSigners)
    .innerJoin(accounts, eq(accounts.id, certificateSigners.accountId))
    .where(eq(certificateSigners.cEmp, cEmp))
    .orderBy(certificateSigners.tier, certificateSigners.createdAt);
  const out = [];
  for (const r of rows) {
    const [e] = await db
      .select({ nombre: employeeSnapshots.nombre })
      .from(employeeSnapshots)
      .where(and(eq(employeeSnapshots.nIde, r.nIde), eq(employeeSnapshots.est, 'V')))
      .limit(1);
    const { hasSignature, digitalEnc, ...rest } = r;
    out.push({
      ...rest,
      name: e?.nombre ?? r.email,
      hasImage: hasSignature !== null && r.consentAt !== null,
      hasDigital:
        digitalEnc !== null &&
        r.digitalConsentAt !== null &&
        (r.digitalNotAfter?.getTime() ?? 0) > Date.now(),
      enrolled:
        (hasSignature !== null && r.consentAt !== null) ||
        (digitalEnc !== null && r.digitalConsentAt !== null),
    });
  }
  return out;
}

/** El administrador designa a la persona por su identificación; la firma la carga ella misma después. */
export async function addSigner(
  db: Db,
  actor: string,
  input: { cEmp: string; nIde: string; title: string; tier: Tier },
) {
  const title = input.title.trim();
  if (
    title.length < 3 ||
    title.length > 100 ||
    (input.tier !== 'PRINCIPAL' && input.tier !== 'RESPALDO')
  )
    throw new SignerError('INVALID_SIGNER');
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.cEmp, input.cEmp));
  if (!company) throw new SignerError('COMPANY_NOT_FOUND');
  const [acct] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.nIde, input.nIde.trim()));
  if (!acct) throw new SignerError('ACCOUNT_NOT_FOUND');
  const row = await db.transaction(async (tx) => {
    const [dup] = await tx
      .select({ id: certificateSigners.id })
      .from(certificateSigners)
      .where(
        and(eq(certificateSigners.cEmp, input.cEmp), eq(certificateSigners.accountId, acct.id)),
      );
    if (dup) throw new SignerError('ALREADY_SIGNER');
    if (!(await hasSignerRole(tx as unknown as Db, acct.id, input.cEmp)))
      await tx.insert(roleAssignments).values({
        accountId: acct.id,
        role: 'CERTIFICATE_APPROVER',
        companyCode: input.cEmp,
        validFrom: today(),
      });
    const [created] = await tx
      .insert(certificateSigners)
      .values({ cEmp: input.cEmp, accountId: acct.id, title, tier: input.tier, createdBy: actor })
      .returning({ id: certificateSigners.id });
    return created;
  });
  await audit(db, actor, 'CERT_SIGNER_ADD', row?.id ?? null, 'SUCCESS', {
    cEmp: input.cEmp,
    tier: input.tier,
  });
  return row;
}

export async function updateSigner(
  db: Db,
  actor: string,
  id: string,
  input: { title?: string | undefined; tier?: Tier | undefined; active?: boolean | undefined },
) {
  const set: Partial<typeof certificateSigners.$inferInsert> = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (t.length < 3 || t.length > 100) throw new SignerError('INVALID_SIGNER');
    set.title = t;
  }
  if (input.tier !== undefined) set.tier = input.tier;
  if (input.active !== undefined) set.active = input.active;
  if (Object.keys(set).length === 0) throw new SignerError('INVALID_SIGNER');
  const res = await db
    .update(certificateSigners)
    .set(set)
    .where(eq(certificateSigners.id, id))
    .returning({ id: certificateSigners.id });
  if (res.length === 0) throw new SignerError('NOT_FOUND');
  await audit(db, actor, 'CERT_SIGNER_UPDATE', id, 'SUCCESS', set);
}

/** Lo que ve una persona designada como firmante sobre sí misma. */
export async function mySigners(db: Db, accountId: string) {
  const rows = await db
    .select({
      id: certificateSigners.id,
      cEmp: certificateSigners.cEmp,
      title: certificateSigners.title,
      tier: certificateSigners.tier,
      active: certificateSigners.active,
      signature: certificateSigners.signature,
      consentAt: certificateSigners.consentAt,
      digitalEnc: certificateSigners.digitalEnc,
      digitalSubject: certificateSigners.digitalSubject,
      digitalFingerprint: certificateSigners.digitalFingerprint,
      digitalNotAfter: certificateSigners.digitalNotAfter,
      digitalOrigin: certificateSigners.digitalOrigin,
      digitalConsentAt: certificateSigners.digitalConsentAt,
    })
    .from(certificateSigners)
    .where(eq(certificateSigners.accountId, accountId));
  return rows.map(({ signature, digitalEnc, ...r }) => ({
    ...r,
    /** Firma como imagen cargada y autorizada. */
    enrolled: signature !== null && r.consentAt !== null,
    /** Firma digital criptográfica cargada, autorizada y no vencida. */
    digital:
      digitalEnc !== null &&
      r.digitalConsentAt !== null &&
      (r.digitalNotAfter?.getTime() ?? 0) > Date.now(),
    digitalExpired: digitalEnc !== null && (r.digitalNotAfter?.getTime() ?? 0) <= Date.now(),
  }));
}

/** La persona carga su propia firma y autoriza su uso; queda registrado cuándo y con qué huella. */
export async function enrollSignature(
  db: Db,
  accountId: string,
  signerId: string,
  file: Buffer,
  consent: boolean,
) {
  const [s] = await db
    .select()
    .from(certificateSigners)
    .where(and(eq(certificateSigners.id, signerId), eq(certificateSigners.accountId, accountId)));
  if (!s) throw new SignerError('NOT_A_SIGNER');
  const fail = async (code: SignerErrorCode): Promise<never> => {
    await audit(db, accountId, 'CERT_SIGNATURE_ENROLL', signerId, code);
    throw new SignerError(code);
  };
  if (!consent) return fail('CONSENT_REQUIRED');
  if (file.length > MAX_SIGNATURE_BYTES) return fail('TOO_LARGE');
  const info = inspectImage(file);
  if (
    !info ||
    info.width < MIN_SIDE ||
    info.height < MIN_SIDE ||
    info.width > MAX_SIDE ||
    info.height > MAX_SIDE
  )
    return fail('INVALID_IMAGE');
  const sha = createHash('sha256').update(file).digest('hex');
  await db
    .update(certificateSigners)
    .set({
      signature: file,
      signatureContentType: info.contentType,
      signatureSha256: sha,
      consentAt: new Date(),
    })
    .where(eq(certificateSigners.id, signerId));
  await audit(db, accountId, 'CERT_SIGNATURE_ENROLL', signerId, 'SUCCESS', { sha256: sha });
}

/** La imagen de la firma solo la puede ver su titular. */
export async function ownSignatureImage(db: Db, accountId: string, signerId: string) {
  const [s] = await db
    .select({ data: certificateSigners.signature, type: certificateSigners.signatureContentType })
    .from(certificateSigners)
    .where(and(eq(certificateSigners.id, signerId), eq(certificateSigners.accountId, accountId)));
  if (!s?.data) throw new SignerError('NOT_FOUND');
  return { data: s.data, contentType: s.type ?? 'image/png' };
}

export interface AvailableSigner {
  id: string;
  accountId: string;
  name: string;
  title: string;
  tier: Tier;
  /** Imagen de la firma (si la cargó y autorizó). */
  signature: Buffer | null;
  signatureSha256: string | null;
  /** Firma digital criptográfica vigente (si la tiene y autorizó). */
  digital: { p12: Buffer; passphrase: string; fingerprint: string } | null;
}

async function ownerName(db: Db, nIde: string, fallback: string): Promise<string> {
  const [e] = await db
    .select({ nombre: employeeSnapshots.nombre })
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, nIde), eq(employeeSnapshots.est, 'V')))
    .limit(1);
  return e?.nombre ?? fallback;
}

/**
 * Firmantes que hoy pueden firmar: designados y activos, con cuenta activa, rol vigente y al menos una
 * forma de firma autorizada por su titular (imagen o firma digital vigente). Con `requireDigital` solo
 * cuentan los que tienen firma digital. Firman los PRINCIPAL; solo si no hay ninguno, los de RESPALDO.
 */
export async function availableSigners(
  db: Db,
  cEmp: string,
  opts: { requireDigital?: boolean } = {},
): Promise<AvailableSigner[]> {
  const rows = await db
    .select({
      id: certificateSigners.id,
      accountId: certificateSigners.accountId,
      title: certificateSigners.title,
      tier: certificateSigners.tier,
      signature: certificateSigners.signature,
      sha: certificateSigners.signatureSha256,
      consentAt: certificateSigners.consentAt,
      digitalEnc: certificateSigners.digitalEnc,
      digitalFingerprint: certificateSigners.digitalFingerprint,
      digitalNotAfter: certificateSigners.digitalNotAfter,
      digitalConsentAt: certificateSigners.digitalConsentAt,
      nIde: accounts.nIde,
      email: accounts.email,
    })
    .from(certificateSigners)
    .innerJoin(accounts, eq(accounts.id, certificateSigners.accountId))
    .where(
      and(
        eq(certificateSigners.cEmp, cEmp),
        eq(certificateSigners.active, true),
        eq(accounts.status, 'ACTIVA'),
      ),
    )
    .orderBy(certificateSigners.createdAt);
  const ok: AvailableSigner[] = [];
  for (const r of rows) {
    const image = r.signature && r.sha && r.consentAt ? { data: r.signature, sha: r.sha } : null;
    let digital: AvailableSigner['digital'] = null;
    if (
      r.digitalEnc &&
      r.digitalConsentAt &&
      r.digitalFingerprint &&
      (r.digitalNotAfter?.getTime() ?? 0) > Date.now()
    ) {
      try {
        const box = JSON.parse(open(r.digitalEnc)) as { p12: string; pass: string };
        digital = {
          p12: Buffer.from(box.p12, 'base64'),
          passphrase: box.pass,
          fingerprint: r.digitalFingerprint,
        };
      } catch {
        digital = null; // no se puede abrir (cambió la clave de ajustes): no firma
      }
    }
    if (opts.requireDigital ? !digital : !image && !digital) continue;
    if (!(await hasSignerRole(db, r.accountId, cEmp))) continue;
    ok.push({
      id: r.id,
      accountId: r.accountId,
      name: await ownerName(db, r.nIde, r.email),
      title: r.title,
      tier: r.tier as Tier,
      signature: image?.data ?? null,
      signatureSha256: image?.sha ?? null,
      digital,
    });
  }
  const principals = ok.filter((x) => x.tier === 'PRINCIPAL');
  return principals.length > 0 ? principals : ok.filter((x) => x.tier === 'RESPALDO');
}

const mapDigital = (e: unknown): never => {
  if (e instanceof DigitalSignatureError) {
    const code =
      e.code === 'INVALID_P12'
        ? 'INVALID_P12'
        : e.code === 'WRONG_PASSPHRASE'
          ? 'WRONG_PASSPHRASE'
          : e.code === 'EXPIRED'
            ? 'EXPIRED_CERT'
            : 'WEAK_KEY';
    throw new SignerError(code);
  }
  throw e;
};

async function ownSigner(db: Db, accountId: string, signerId: string) {
  const [s] = await db
    .select()
    .from(certificateSigners)
    .where(and(eq(certificateSigners.id, signerId), eq(certificateSigners.accountId, accountId)));
  if (!s) throw new SignerError('NOT_A_SIGNER');
  return s;
}

async function saveDigital(
  db: Db,
  signerId: string,
  accountId: string,
  p12: Buffer,
  passphrase: string,
  info: { subject: string; fingerprint: string; notAfter: Date },
  origin: 'AUTOFIRMADO' | 'CARGADO',
) {
  await db
    .update(certificateSigners)
    .set({
      digitalEnc: seal(JSON.stringify({ p12: p12.toString('base64'), pass: passphrase })),
      digitalSubject: info.subject,
      digitalFingerprint: info.fingerprint,
      digitalNotAfter: info.notAfter,
      digitalOrigin: origin,
      digitalConsentAt: new Date(),
    })
    .where(eq(certificateSigners.id, signerId));
  await audit(db, accountId, 'CERT_DIGITAL_ENROLL', signerId, 'SUCCESS', {
    origin,
    fingerprint: info.fingerprint,
    notAfter: info.notAfter.toISOString(),
  });
}

/** La persona sube su propio certificado (.p12/.pfx) y clave, expedidos por una entidad de certificación. */
export async function enrollDigitalUpload(
  db: Db,
  accountId: string,
  signerId: string,
  p12: Buffer,
  passphrase: string,
  consent: boolean,
) {
  await ownSigner(db, accountId, signerId);
  if (!consent) {
    await audit(db, accountId, 'CERT_DIGITAL_ENROLL', signerId, 'CONSENT_REQUIRED');
    throw new SignerError('CONSENT_REQUIRED');
  }
  if (p12.length > 64 * 1024 || passphrase.length > 200) throw new SignerError('INVALID_P12');
  try {
    const info = await inspectP12(p12, passphrase);
    await saveDigital(db, signerId, accountId, p12, passphrase, info, 'CARGADO');
    return {
      subject: info.subject,
      fingerprint: info.fingerprint,
      notAfter: info.notAfter,
      selfSigned: info.selfSigned,
    };
  } catch (e) {
    await audit(
      db,
      accountId,
      'CERT_DIGITAL_ENROLL',
      signerId,
      e instanceof DigitalSignatureError ? e.code : 'ERROR',
    );
    return mapDigital(e);
  }
}

/** NOMFLOW genera un certificado autofirmado para la persona (pruebas o uso interno; no lo respalda una entidad de certificación). */
export async function enrollDigitalGenerate(
  db: Db,
  accountId: string,
  signerId: string,
  consent: boolean,
) {
  const s = await ownSigner(db, accountId, signerId);
  if (!consent) {
    await audit(db, accountId, 'CERT_DIGITAL_ENROLL', signerId, 'CONSENT_REQUIRED');
    throw new SignerError('CONSENT_REQUIRED');
  }
  const [a] = await db
    .select({ nIde: accounts.nIde, email: accounts.email })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const [c] = await db
    .select({ nombre: companies.nombre })
    .from(companies)
    .where(eq(companies.cEmp, s.cEmp));
  const passphrase = randomBytes(24).toString('base64url');
  const made = generateSelfSigned({
    name: await ownerName(db, a?.nIde ?? '', a?.email ?? 'Firmante'),
    organization: c?.nombre ?? s.cEmp,
    email: a?.email ?? '',
    passphrase,
  });
  await saveDigital(db, signerId, accountId, made.p12, passphrase, made.info, 'AUTOFIRMADO');
  return {
    subject: made.info.subject,
    fingerprint: made.info.fingerprint,
    notAfter: made.info.notAfter,
    selfSigned: true,
  };
}

export async function removeDigital(db: Db, accountId: string, signerId: string) {
  await ownSigner(db, accountId, signerId);
  await db
    .update(certificateSigners)
    .set({
      digitalEnc: null,
      digitalSubject: null,
      digitalFingerprint: null,
      digitalNotAfter: null,
      digitalOrigin: null,
      digitalConsentAt: null,
    })
    .where(eq(certificateSigners.id, signerId));
  await audit(db, accountId, 'CERT_DIGITAL_REMOVE', signerId, 'SUCCESS');
}

/** Parte pública (certificado X.509 en PEM) del firmante digital, para que otros confíen en él. Nunca la clave privada. */
export async function ownCertificatePem(
  db: Db,
  accountId: string,
  signerId: string,
): Promise<string> {
  const s = await ownSigner(db, accountId, signerId);
  if (!s.digitalEnc) throw new SignerError('NO_DIGITAL');
  const box = JSON.parse(open(s.digitalEnc)) as { p12: string; pass: string };
  return (await inspectP12(Buffer.from(box.p12, 'base64'), box.pass).catch(mapDigital)).certPem;
}
