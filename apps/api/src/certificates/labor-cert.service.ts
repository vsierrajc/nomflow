import { createHash, randomUUID } from 'node:crypto';
import { and, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  auditLogs,
  catalogEntries,
  certificateRequests,
  certificateSettings,
  certificateTemplates,
  companies,
  employeeSnapshots,
} from '../db/schema';
import { logoForCompanyCode } from '../org/logos.service';
import { archivedKeys } from '../storage/archive.service';
import { signPdf, verifyPdfSignature, type SignatureReport } from './digital-signature';
import { availableSigners, type AvailableSigner } from './signers.service';
import { ObjectStoreError, type ObjectStore } from '../storage/object-store';
import { renderLaborCertificatePdf } from './labor-cert.pdf';
import {
  DEFAULT_TEMPLATES,
  MissingDataError,
  extractVariables,
  formatCop,
  longDateEs,
  renderTemplate,
  salaryInWords,
  validateTemplate,
  type CertKind,
  type VariableName,
} from './template-engine';

export type CertErrorCode =
  | 'NOT_FOUND'
  | 'NO_ACTIVE_CONTRACT'
  | 'MODE_NOT_ALLOWED'
  | 'ADDRESSEE_REQUIRED'
  | 'MISSING_DATA'
  | 'LIMIT_REACHED'
  | 'NO_SIGNER'
  | 'SIGNER_NOT_ALLOWED'
  | 'INVALID_TEMPLATE'
  | 'INVALID_SETTINGS'
  | 'INTEGRITY';

export class CertError extends Error {
  constructor(
    readonly code: CertErrorCode,
    readonly details: string[] = [],
  ) {
    super(code);
  }
}

export type CertMode = 'GENERAL' | 'DIRIGIDO' | 'AMBOS';
export interface CertSettingsValues {
  mode: CertMode;
  docCode: string;
  docVersion: string;
  docDate: string;
  city: string;
  footerText: string;
  maxPerDay: number;
  /** Solo firman quienes tienen firma digital criptográfica vigente. */
  requireDigital: boolean;
}

const FIELD_LABEL: Partial<Record<VariableName, string>> = {
  CARGO: 'cargo',
  AREA: 'área',
  CCOSTO: 'centro de costo',
  TIPO_CONTRATO: 'tipo de contrato',
  F_INI: 'fecha de inicio',
  S_ACT: 'salario',
  S_ACT_LETRAS: 'salario',
  CIUDAD_EMISION: 'ciudad de emisión (configuración del certificado)',
  NOMBRE: 'nombre',
};

const clip = (s: string, n: number) => s.trim().slice(0, n);
const stripControl = (v: string) =>
  Array.from(v, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('');
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());

async function audit(
  db: Db,
  actor: string | null,
  action: string,
  resourceId: string | null,
  result: string,
  context: object = {},
) {
  await db.insert(auditLogs).values({
    actorAccountId: actor,
    action,
    resource: 'labor_certificate',
    resourceId,
    result,
    context,
  });
}

export function validSettings(i: CertSettingsValues): boolean {
  return (
    ['GENERAL', 'DIRIGIDO', 'AMBOS'].includes(i.mode) &&
    i.docCode.trim().length >= 1 &&
    i.docCode.length <= 40 &&
    i.docVersion.trim().length >= 1 &&
    i.docVersion.length <= 20 &&
    i.docDate.length <= 40 &&
    i.city.trim().length >= 1 &&
    i.city.length <= 80 &&
    i.footerText.length <= 500 &&
    i.footerText.split('\n').length <= 4 &&
    Number.isInteger(i.maxPerDay) &&
    i.maxPerDay >= 1 &&
    i.maxPerDay <= 100
  );
}

/** Deja en las tablas la configuración y las plantillas por omisión de la empresa (una sola vez). */
export async function ensureDefaults(db: Db, cEmp: string) {
  await db.insert(certificateSettings).values({ cEmp }).onConflictDoNothing();
  for (const kind of ['GENERAL', 'DIRIGIDO'] as const) {
    const [has] = await db
      .select({ id: certificateTemplates.id })
      .from(certificateTemplates)
      .where(and(eq(certificateTemplates.cEmp, cEmp), eq(certificateTemplates.kind, kind)))
      .limit(1);
    if (has) continue;
    const t = DEFAULT_TEMPLATES[kind];
    await db
      .insert(certificateTemplates)
      .values({
        cEmp,
        kind,
        version: 1,
        title: t.title,
        bodyTemplate: t.body,
        contentHash: createHash('sha256').update(`${t.title}\n${t.body}`).digest('hex'),
      })
      .onConflictDoNothing();
  }
}

export async function getSettings(db: Db, cEmp: string): Promise<CertSettingsValues> {
  await ensureDefaults(db, cEmp);
  const [s] = await db.select().from(certificateSettings).where(eq(certificateSettings.cEmp, cEmp));
  if (!s) throw new CertError('NOT_FOUND');
  return {
    mode: s.mode as CertMode,
    docCode: s.docCode,
    docVersion: s.docVersion,
    docDate: s.docDate,
    city: s.city,
    footerText: s.footerText,
    maxPerDay: s.maxPerDay,
    requireDigital: s.requireDigital,
  };
}

export async function saveSettings(db: Db, actor: string, cEmp: string, input: CertSettingsValues) {
  if (!validSettings(input)) throw new CertError('INVALID_SETTINGS');
  await ensureDefaults(db, cEmp);
  await db
    .update(certificateSettings)
    .set({ ...input, updatedBy: actor, updatedAt: new Date() })
    .where(eq(certificateSettings.cEmp, cEmp));
  await audit(db, actor, 'LABOR_CERT_SETTINGS_UPDATE', cEmp, 'SUCCESS', input);
  return getSettings(db, cEmp);
}

export async function listTemplates(db: Db, cEmp: string) {
  await ensureDefaults(db, cEmp);
  return db
    .select()
    .from(certificateTemplates)
    .where(eq(certificateTemplates.cEmp, cEmp))
    .orderBy(certificateTemplates.kind, desc(certificateTemplates.version));
}

/** Guardar cambia el contenido: se crea una versión nueva y la anterior queda retirada, sin borrarse. */
export async function saveTemplate(
  db: Db,
  actor: string,
  cEmp: string,
  kind: CertKind,
  input: { title: string; body: string },
) {
  const problems = validateTemplate(kind, input.title, input.body);
  if (problems.length > 0) {
    await audit(db, actor, 'LABOR_CERT_TEMPLATE_SAVE', null, 'INVALID', { kind });
    throw new CertError('INVALID_TEMPLATE', problems);
  }
  await ensureDefaults(db, cEmp);
  const row = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`cert-template:${cEmp}:${kind}`}))`,
    );
    const [cur] = await tx
      .select()
      .from(certificateTemplates)
      .where(and(eq(certificateTemplates.cEmp, cEmp), eq(certificateTemplates.kind, kind)))
      .orderBy(desc(certificateTemplates.version))
      .limit(1);
    if (
      cur &&
      cur.title === input.title.trim() &&
      cur.bodyTemplate === input.body.trim() &&
      cur.status === 'VIGENTE'
    )
      return cur;
    await tx
      .update(certificateTemplates)
      .set({ status: 'RETIRADA' })
      .where(
        and(
          eq(certificateTemplates.cEmp, cEmp),
          eq(certificateTemplates.kind, kind),
          eq(certificateTemplates.status, 'VIGENTE'),
        ),
      );
    const [created] = await tx
      .insert(certificateTemplates)
      .values({
        cEmp,
        kind,
        version: (cur?.version ?? 0) + 1,
        title: input.title.trim(),
        bodyTemplate: input.body.trim(),
        contentHash: createHash('sha256')
          .update(`${input.title.trim()}\n${input.body.trim()}`)
          .digest('hex'),
        createdBy: actor,
      })
      .returning();
    return created;
  });
  if (!row) throw new Error('plantilla no creada');
  await audit(db, actor, 'LABOR_CERT_TEMPLATE_SAVE', row.id, 'SUCCESS', {
    kind,
    version: row.version,
  });
  return row;
}

interface Company {
  nombre: string;
  sigla: string;
  direccion: string;
}

async function companyOf(db: Db, cEmp: string): Promise<Company> {
  const [c] = await db.select().from(companies).where(eq(companies.cEmp, cEmp));
  return c
    ? { nombre: c.nombre, sigla: c.sigla, direccion: c.direccion }
    : { nombre: cEmp, sigla: cEmp, direccion: '' };
}

async function catalogName(
  db: Db,
  type: 'AREA' | 'CARGO' | 'CCOSTO' | 'TIPO_CONTRATO',
  cEmp: string,
  code: string | null,
) {
  if (!code) return null;
  const [r] = await db
    .select({ name: catalogEntries.name })
    .from(catalogEntries)
    .where(
      and(
        eq(catalogEntries.type, type),
        eq(catalogEntries.cEmp, type === 'TIPO_CONTRATO' ? '' : cEmp),
        eq(catalogEntries.code, code),
        eq(catalogEntries.active, true),
      ),
    );
  return r?.name ?? null;
}

type Snapshot = typeof employeeSnapshots.$inferSelect;

async function valuesFor(
  db: Db,
  e: Snapshot,
  company: Company,
  s: CertSettingsValues,
  extra: { addressee?: string | null; signer?: { name: string; title: string } | null },
) {
  const cEmp = e.cEmp ?? '';
  const [area, cargo, ccosto, tipo] = await Promise.all([
    catalogName(db, 'AREA', cEmp, e.cArea),
    catalogName(db, 'CARGO', cEmp, e.cCar),
    catalogName(db, 'CCOSTO', cEmp, e.cCos),
    catalogName(db, 'TIPO_CONTRATO', cEmp, e.tipoContrato),
  ]);
  const v: Partial<Record<VariableName, string | null>> = {
    N_IDE: e.nIde,
    NOMBRE: e.nombre,
    N_CONT: e.nCont,
    F_INI: e.fIni ? longDateEs(e.fIni) : null,
    C_CAR: e.cCar,
    CARGO: cargo ?? e.cargo,
    C_COS: e.cCos,
    CCOSTO: ccosto ?? e.cCosto,
    C_AREA: e.cArea,
    AREA: area ?? e.area,
    TIPO_CONTRATO: tipo,
    S_ACT: e.sAct ? formatCop(e.sAct) : null,
    S_ACT_LETRAS: e.sAct ? salaryInWords(e.sAct) : null,
    EMPRESA_NOMBRE: company.nombre,
    EMPRESA_SIGLA: company.sigla,
    EMPRESA_DIRECCION: company.direccion,
    CIUDAD_EMISION: s.city,
    FECHA_EMISION: longDateEs(today()),
    DESTINATARIO: extra.addressee ?? null,
    FIRMANTE_NOMBRE: extra.signer?.name ?? null,
    FIRMANTE_CARGO: extra.signer?.title ?? null,
  };
  return v;
}

const footerOf = (s: CertSettingsValues) =>
  s.footerText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Modalidades que puede pedir el empleado, según lo que configuró el administrador. */
export async function optionsFor(db: Db, accountId: string) {
  const e = await activeContract(db, accountId);
  const s = await getSettings(db, e.cEmp ?? '');
  const company = await companyOf(db, e.cEmp ?? '');
  const kinds: CertKind[] = s.mode === 'AMBOS' ? ['GENERAL', 'DIRIGIDO'] : [s.mode];
  const signers = await availableSigners(db, e.cEmp ?? '', { requireDigital: s.requireDigital });
  return {
    kinds,
    company: company.nombre,
    maxPerDay: s.maxPerDay,
    /** Quiénes pueden firmar hoy; con más de uno el empleado elige. Sin ninguno no se puede generar. */
    signers: signers.map((x) => ({
      id: x.id,
      name: x.name,
      title: x.title,
      digital: x.digital !== null,
    })),
  };
}

async function activeContract(db: Db, accountId: string): Promise<Snapshot> {
  const [a] = await db
    .select({ nIde: accounts.nIde })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!a) throw new CertError('NOT_FOUND');
  const rows = await db
    .select()
    .from(employeeSnapshots)
    .where(and(eq(employeeSnapshots.nIde, a.nIde), eq(employeeSnapshots.est, 'V')));
  if (rows.length !== 1 || !rows[0]) throw new CertError('NO_ACTIVE_CONTRACT');
  return rows[0];
}

async function currentTemplate(db: Db, cEmp: string, kind: CertKind) {
  await ensureDefaults(db, cEmp);
  const [t] = await db
    .select()
    .from(certificateTemplates)
    .where(
      and(
        eq(certificateTemplates.cEmp, cEmp),
        eq(certificateTemplates.kind, kind),
        eq(certificateTemplates.status, 'VIGENTE'),
      ),
    );
  if (!t) throw new CertError('NOT_FOUND');
  return t;
}

function build(
  t: { title: string; bodyTemplate: string },
  values: Partial<Record<VariableName, string | null>>,
) {
  try {
    return renderTemplate(t.bodyTemplate, values);
  } catch (e) {
    if (e instanceof MissingDataError)
      throw new CertError('MISSING_DATA', [
        ...new Set(e.fields.map((f) => FIELD_LABEL[f as VariableName] ?? f)),
      ]);
    throw e;
  }
}

/** El empleado genera su certificado: se valida, se crea el PDF, se guarda cifrado y se registra en el historial. */
export async function issue(
  db: Db,
  store: ObjectStore,
  accountId: string,
  input: {
    kind?: CertKind | undefined;
    addressee?: string | undefined;
    signerId?: string | undefined;
  },
) {
  const e = await activeContract(db, accountId);
  const cEmp = e.cEmp ?? '';
  const s = await getSettings(db, cEmp);
  const kind: CertKind | undefined = input.kind ?? (s.mode === 'AMBOS' ? undefined : s.mode);
  if (!kind || (s.mode !== 'AMBOS' && s.mode !== kind)) throw new CertError('MODE_NOT_ALLOWED');
  const addressee = kind === 'DIRIGIDO' ? clip(stripControl(input.addressee ?? ''), 200) : null;
  if (kind === 'DIRIGIDO' && (addressee ?? '').length < 3)
    throw new CertError('ADDRESSEE_REQUIRED');

  const since = new Date(Date.now() - 24 * 3_600_000);
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(certificateRequests)
    .where(
      and(eq(certificateRequests.accountId, accountId), gte(certificateRequests.createdAt, since)),
    );
  if (n >= s.maxPerDay) throw new CertError('LIMIT_REACHED');

  // Firma quien esté disponible; con varios, la persona que eligió el empleado.
  const candidates = await availableSigners(db, cEmp, { requireDigital: s.requireDigital });
  if (candidates.length === 0) throw new CertError('NO_SIGNER');
  const signer: AvailableSigner | undefined = input.signerId
    ? candidates.find((c) => c.id === input.signerId)
    : candidates[0];
  if (!signer) throw new CertError('SIGNER_NOT_ALLOWED');

  const t = await currentTemplate(db, cEmp, kind);
  const company = await companyOf(db, cEmp);
  const values = await valuesFor(db, e, company, s, {
    addressee,
    signer: { name: signer.name, title: signer.title },
  });
  const body = build(t, values);

  const id = randomUUID();
  const issuedAt = new Date();
  const unsigned = await renderLaborCertificatePdf({
    ref: id.slice(0, 8).toUpperCase(),
    title: t.title,
    body,
    company,
    logo: await logoForCompanyCode(db, cEmp),
    docCode: s.docCode,
    docVersion: s.docVersion,
    docDate: s.docDate,
    signer: { name: signer.name, title: signer.title, signature: signer.signature },
    digital: signer.digital
      ? {
          reason: 'Certificado laboral',
          name: signer.name,
          location: s.city,
          contact: company.nombre,
        }
      : undefined,
    footerLines: footerOf(s),
    issuedAt,
  });
  // Con firma digital, el PDF definitivo es el firmado: la huella guardada es la de estos bytes.
  const pdf = signer.digital
    ? await signPdf(unsigned, signer.digital.p12, signer.digital.passphrase)
    : unsigned;
  const signatureMode = signer.digital
    ? signer.signature
      ? 'IMAGEN+DIGITAL'
      : 'DIGITAL'
    : 'IMAGEN';
  const objectKey = `labor-certificates/${id}.pdf`;
  await store.put(objectKey, pdf, 'application/pdf');
  // Copia de lo que dice el documento: nombre e identificación siempre, más las variables que usó la plantilla.
  const used = Object.fromEntries(
    ['NOMBRE', 'N_IDE', ...extractVariables(t.bodyTemplate)].map((k) => [
      k,
      values[k as VariableName] ?? null,
    ]),
  );
  await db.insert(certificateRequests).values({
    id,
    accountId,
    nIde: e.nIde,
    nCont: e.nCont,
    cEmp,
    kind,
    addressee,
    templateId: t.id,
    templateVersion: t.version,
    docCode: s.docCode,
    docVersion: s.docVersion,
    signerAccountId: signer.accountId,
    signerName: signer.name,
    signerTitle: signer.title,
    signatureSha256: signer.signatureSha256,
    signatureMode,
    signerCertFingerprint: signer.digital?.fingerprint ?? null,
    snapshot: used,
    objectKey,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    sizeBytes: pdf.length,
    createdAt: issuedAt,
  });
  await audit(db, accountId, 'LABOR_CERT_ISSUE', id, 'SUCCESS', {
    kind,
    templateVersion: t.version,
    docCode: s.docCode,
    signer: signer.accountId,
    signatureMode,
  });
  return { id, kind, createdAt: issuedAt, docCode: s.docCode, docVersion: s.docVersion };
}

/** Vista previa del administrador con datos ficticios: no se guarda ni se registra como emisión. */
export async function preview(
  db: Db,
  cEmp: string,
  kind: CertKind,
  draft?: { title: string; body: string },
) {
  const s = await getSettings(db, cEmp);
  let t: { title: string; body: string };
  if (draft) t = draft;
  else {
    const cur = await currentTemplate(db, cEmp, kind);
    t = { title: cur.title, body: cur.bodyTemplate };
  }
  const problems = validateTemplate(kind, t.title, t.body);
  if (problems.length > 0) throw new CertError('INVALID_TEMPLATE', problems);
  const company = await companyOf(db, cEmp);
  const fake = {
    id: randomUUID(),
    nIde: '1000000001',
    nCont: '1',
    nombre: 'MARÍA FERNANDA PÉREZ GÓMEZ',
    cEmp,
    fIni: '2020-02-03',
    sAct: '2500000',
    cCar: 'C001',
    cargo: 'ANALISTA DE EJEMPLO',
    cCos: 'K001',
    cCosto: 'CENTRO DE EJEMPLO',
    cArea: 'A001',
    area: 'ÁREA DE EJEMPLO',
    tipoContrato: 'T1',
  } as unknown as Snapshot;
  const values = await valuesFor(db, fake, company, s, {
    addressee: kind === 'DIRIGIDO' ? 'QUIEN CORRESPONDA (EJEMPLO)' : null,
    signer: { name: 'NOMBRE DEL FIRMANTE (EJEMPLO)', title: 'Cargo del firmante' },
  });
  values.TIPO_CONTRATO = values.TIPO_CONTRATO ?? 'Contrato de ejemplo';
  values.CARGO = values.CARGO ?? 'ANALISTA DE EJEMPLO';
  const body = build({ title: t.title, bodyTemplate: t.body }, values);
  return renderLaborCertificatePdf({
    ref: 'PREVIA',
    title: t.title,
    body,
    company,
    logo: await logoForCompanyCode(db, cEmp),
    docCode: s.docCode,
    docVersion: s.docVersion,
    docDate: s.docDate,
    signer: { name: 'NOMBRE DEL FIRMANTE (EJEMPLO)', title: 'Cargo del firmante', signature: null },
    footerLines: footerOf(s),
    issuedAt: new Date(),
    preview: true,
  });
}

export async function listMine(db: Db, accountId: string) {
  const rows = await db
    .select({
      id: certificateRequests.id,
      kind: certificateRequests.kind,
      addressee: certificateRequests.addressee,
      docCode: certificateRequests.docCode,
      docVersion: certificateRequests.docVersion,
      createdAt: certificateRequests.createdAt,
      sizeBytes: certificateRequests.sizeBytes,
      signatureMode: certificateRequests.signatureMode,
      objectKey: certificateRequests.objectKey,
    })
    .from(certificateRequests)
    .where(eq(certificateRequests.accountId, accountId))
    .orderBy(desc(certificateRequests.createdAt))
    .limit(100);
  // `archived`: el PDF solo está en el archivo histórico en la nube y la descarga tardará algo más.
  const inCloud = await archivedKeys(
    db,
    rows.map((r) => r.objectKey),
  );
  return rows.map(({ objectKey, ...r }) => ({ ...r, archived: inCloud.has(objectKey) }));
}

export interface HistoryQuery {
  q?: string | undefined;
  kind?: CertKind | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

/** Historial para el administrador: todas las solicitudes, con filtros. Sin salarios ni valores del documento. */
export async function adminHistory(db: Db, q: HistoryQuery) {
  const filters = [];
  if (q.kind) filters.push(eq(certificateRequests.kind, q.kind));
  if (q.from)
    filters.push(gte(certificateRequests.createdAt, new Date(`${q.from}T00:00:00-05:00`)));
  if (q.to)
    filters.push(lte(certificateRequests.createdAt, new Date(`${q.to}T23:59:59.999-05:00`)));
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    filters.push(
      or(
        ilike(certificateRequests.nIde, like),
        sql`${certificateRequests.snapshot}->>'NOMBRE' ilike ${like}`,
        ilike(certificateRequests.addressee, like),
      ),
    );
  }
  const where = filters.length > 0 ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(certificateRequests)
    .where(where);
  const items = await db
    .select({
      id: certificateRequests.id,
      createdAt: certificateRequests.createdAt,
      nIde: certificateRequests.nIde,
      nombre: sql<string>`${certificateRequests.snapshot}->>'NOMBRE'`,
      cEmp: certificateRequests.cEmp,
      kind: certificateRequests.kind,
      addressee: certificateRequests.addressee,
      docCode: certificateRequests.docCode,
      docVersion: certificateRequests.docVersion,
      templateVersion: certificateRequests.templateVersion,
      signerName: certificateRequests.signerName,
      signerTitle: certificateRequests.signerTitle,
      signatureMode: certificateRequests.signatureMode,
      sizeBytes: certificateRequests.sizeBytes,
    })
    .from(certificateRequests)
    .where(where)
    .orderBy(desc(certificateRequests.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { total, page: q.page, pageSize: q.pageSize, items };
}

/** Descarga: el dueño o un administrador; se comprueba la huella y se audita. */
export async function getPdf(
  db: Db,
  store: ObjectStore,
  viewerId: string,
  id: string,
  asAdmin: boolean,
) {
  const [r] = await db.select().from(certificateRequests).where(eq(certificateRequests.id, id));
  if (!r || (!asAdmin && r.accountId !== viewerId)) throw new CertError('NOT_FOUND');
  let data: Buffer | null;
  try {
    data = await store.get(r.objectKey);
  } catch (e) {
    await audit(
      db,
      viewerId,
      'LABOR_CERT_DOWNLOAD',
      id,
      e instanceof ObjectStoreError ? e.code : 'ERROR',
      { asAdmin },
    );
    throw e;
  }
  if (!data) {
    await audit(db, viewerId, 'LABOR_CERT_DOWNLOAD', id, 'OBJECT_MISSING', { asAdmin });
    throw new CertError('INTEGRITY');
  }
  if (createHash('sha256').update(data).digest('hex') !== r.sha256) {
    await audit(db, viewerId, 'LABOR_CERT_DOWNLOAD', id, 'HASH_MISMATCH', { asAdmin });
    throw new CertError('INTEGRITY');
  }
  await audit(db, viewerId, 'LABOR_CERT_DOWNLOAD', id, 'OK', { asAdmin });
  return {
    data,
    fileName: `certificado-laboral-${r.nIde}-${r.createdAt.toISOString().slice(0, 10)}.pdf`,
  };
}

/** Verifica un certificado emitido: huella del archivo guardado y, si lleva firma digital, su validez criptográfica. */
export async function verifyIssued(
  db: Db,
  store: ObjectStore,
  viewerId: string,
  id: string,
  asAdmin: boolean,
) {
  const f = await getPdf(db, store, viewerId, id, asAdmin); // comprueba dueño/administrador y la huella del archivo
  const [r] = await db
    .select({
      mode: certificateRequests.signatureMode,
      fingerprint: certificateRequests.signerCertFingerprint,
      signerName: certificateRequests.signerName,
    })
    .from(certificateRequests)
    .where(eq(certificateRequests.id, id));
  const report: SignatureReport = verifyPdfSignature(f.data);
  return {
    fileIntact: true,
    signatureMode: r?.mode ?? null,
    signerName: r?.signerName ?? null,
    digital: report,
    /** El certificado que firmó es el que se registró al emitir. */
    certificateMatchesRecord:
      report.signed && r?.fingerprint ? report.fingerprint === r.fingerprint : null,
  };
}
