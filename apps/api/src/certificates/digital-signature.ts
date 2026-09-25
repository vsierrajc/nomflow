import { createHash, randomBytes, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { P12Signer } from '@signpdf/signer-p12';
import signpdf from '@signpdf/signpdf';
import forge from 'node-forge';

/**
 * Firma digital criptográfica del PDF (PAdES básico: adbe.pkcs7.detached, SHA-256, RSA).
 * El PDF se genera con un espacio reservado para la firma; luego se firma con el PKCS#12 del firmante.
 */

export const SIGNATURE_LENGTH = 8192; // bytes reservados para el PKCS#7
const NUM_PLACEHOLDER = '11111111111'; // 11 cifras: mismo largo que «/**********»
const STAR_PLACEHOLDER = '**********';

/** Objetos del PDF para el campo de firma; se llama antes de cerrar el documento de pdfkit. */
export function addSignaturePlaceholder(
  doc: PDFKit.PDFDocument,
  info: { reason: string; name: string; location: string; contact: string },
): void {
  // ByteRange con números de 11 dígitos que luego se cambian por marcas: así tiene el largo exacto.
  const sig = (doc as unknown as { ref: (d: object) => { end: () => void } }).ref({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, Number(NUM_PLACEHOLDER), Number(NUM_PLACEHOLDER), Number(NUM_PLACEHOLDER)],
    Contents: Buffer.alloc(SIGNATURE_LENGTH),
    Reason: new String(info.reason),
    M: new Date(),
    ContactInfo: new String(info.contact),
    Name: new String(info.name),
    Location: new String(info.location),
  });
  sig.end();
  const widget = (doc as unknown as { ref: (d: object) => { end: () => void } }).ref({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 0, 0],
    V: sig,
    T: new String('Firma1'),
    F: 4,
    P: (doc as unknown as { page: { dictionary: unknown } }).page.dictionary,
  });
  widget.end();
  const page = (doc as unknown as { page: { dictionary: { data: Record<string, unknown> } } }).page;
  page.dictionary.data.Annots = [widget];
  // pdfkit administra el AcroForm y lo cierra al terminar el documento.
  const d = doc as unknown as {
    initForm: () => void;
    _root: {
      data: {
        AcroForm: { data: { Fields: unknown[]; SigFlags?: number; NeedAppearances?: boolean } };
      };
    };
  };
  d.initForm();
  const acro = d._root.data.AcroForm;
  acro.data.Fields.push(widget);
  acro.data.SigFlags = 3;
  acro.data.NeedAppearances = false;
}

/** Cambia las cifras del ByteRange por las marcas que reconoce el firmante (mismo largo). */
export function markByteRange(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1');
  const from = `/ByteRange [0 ${NUM_PLACEHOLDER} ${NUM_PLACEHOLDER} ${NUM_PLACEHOLDER}]`;
  const at = text.indexOf(from);
  if (at < 0) throw new Error('El PDF no tiene espacio reservado para la firma.');
  const to = `/ByteRange [0 /${STAR_PLACEHOLDER} /${STAR_PLACEHOLDER} /${STAR_PLACEHOLDER}]`;
  return Buffer.concat([
    pdf.subarray(0, at),
    Buffer.from(to, 'latin1'),
    pdf.subarray(at + from.length),
  ]);
}

export interface CertInfo {
  subject: string;
  issuer: string;
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
  selfSigned: boolean;
  keyBits: number;
}

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const attr = (c: forge.pki.Certificate['subject'], name: string) =>
  String(c.getField(name)?.value ?? '');
const dn = (c: forge.pki.Certificate['subject']) =>
  ['CN', 'O', 'C']
    .map((k) => attr(c, k))
    .filter(Boolean)
    .join(', ');

function certInfo(cert: forge.pki.Certificate): CertInfo {
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const pub = cert.publicKey as forge.pki.rsa.PublicKey;
  return {
    subject: dn(cert.subject),
    issuer: dn(cert.issuer),
    fingerprint: sha256hex(der),
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    selfSigned: cert.subject.hash === cert.issuer.hash,
    keyBits: pub.n ? pub.n.bitLength() : 0,
  };
}

/** Certificado autofirmado de pruebas para un firmante (RSA 2048, 2 años). No lo respalda una entidad de certificación. */
export function generateSelfSigned(input: {
  name: string;
  organization: string;
  email: string;
  passphrase: string;
  /** Solo para pruebas: vigencia distinta de la de 2 años. */
  validity?: { from: Date; to: Date };
}) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(15).toString('hex')}`;
  cert.validity.notBefore = input.validity?.from ?? new Date(Date.now() - 5 * 60_000);
  cert.validity.notAfter = input.validity?.to ?? new Date(Date.now() + 2 * 365 * 86_400_000);
  const attrs = [
    { name: 'commonName', value: input.name },
    { name: 'organizationName', value: input.organization },
    { name: 'countryName', value: 'CO' },
    { name: 'emailAddress', value: input.email },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], input.passphrase, {
    algorithm: 'aes256',
    friendlyName: input.name,
  });
  const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
  return { p12, certPem: forge.pki.certificateToPem(cert), info: certInfo(cert) };
}

export class DigitalSignatureError extends Error {
  constructor(readonly code: 'INVALID_P12' | 'WRONG_PASSPHRASE' | 'EXPIRED' | 'WEAK_KEY') {
    super(code);
  }
}

/** Abre un PKCS#12 con su clave, comprueba que sirve para firmar y devuelve los datos de su certificado. */
export async function inspectP12(
  p12: Buffer,
  passphrase: string,
): Promise<CertInfo & { certPem: string }> {
  let parsed: forge.pkcs12.Pkcs12Pfx;
  try {
    parsed = forge.pkcs12.pkcs12FromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary'))),
      false,
      passphrase,
    );
  } catch (e) {
    throw new DigitalSignatureError(
      /password|mac/i.test((e as Error).message) ? 'WRONG_PASSPHRASE' : 'INVALID_P12',
    );
  }
  const KEY_OID = forge.pki.oids.pkcs8ShroudedKeyBag ?? '';
  const CERT_OID = forge.pki.oids.certBag ?? '';
  const keyBags = parsed.getBags({ bagType: KEY_OID })[KEY_OID] ?? [];
  const certBags = parsed.getBags({ bagType: CERT_OID })[CERT_OID] ?? [];
  const key = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined;
  const cert = certBags
    .map((b: forge.pkcs12.Bag) => b.cert)
    .find(
      (c: forge.pki.Certificate | undefined) =>
        Boolean(c && key) &&
        (c?.publicKey as forge.pki.rsa.PublicKey).n.compareTo(
          (key as forge.pki.rsa.PrivateKey).n,
        ) === 0,
    );
  if (!key || !cert) throw new DigitalSignatureError('INVALID_P12');
  const info = certInfo(cert);
  if (info.keyBits < 2048) throw new DigitalSignatureError('WEAK_KEY');
  if (info.notAfter.getTime() <= Date.now()) throw new DigitalSignatureError('EXPIRED');
  // Prueba real de firma: si el firmante no puede firmar, se descubre aquí y no al emitir un certificado.
  try {
    await new P12Signer(p12, { passphrase }).sign(Buffer.from('prueba'));
  } catch {
    throw new DigitalSignatureError('INVALID_P12');
  }
  return { ...info, certPem: forge.pki.certificateToPem(cert) };
}

/** Firma el PDF (que ya trae el espacio reservado) con el certificado del firmante. */
export async function signPdf(pdf: Buffer, p12: Buffer, passphrase: string): Promise<Buffer> {
  return signpdf.sign(markByteRange(pdf), new P12Signer(p12, { passphrase }), new Date());
}

/**
 * El campo /Contents lleva el PKCS#7 seguido de ceros de relleno. Se recorta según el largo que declara
 * el propio DER (no quitando ceros del final: la firma puede terminar legítimamente en 0x00).
 */
export function derFromContents(buf: Buffer): Buffer {
  if (buf[0] !== 0x30) throw new Error('DER inválido');
  const first = buf[1] ?? 0;
  let len = first;
  let header = 2;
  if (first & 0x80) {
    const n = first & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[2 + i] ?? 0);
    header = 2 + n;
  }
  return buf.subarray(0, header + len);
}

export interface SignatureReport {
  signed: boolean;
  /** La firma coincide con los bytes cubiertos y con el certificado incluido. */
  valid: boolean;
  /** La firma cubre todo el archivo (no hay nada añadido después). */
  coversWholeFile: boolean;
  signer?: string;
  fingerprint?: string;
  selfSigned?: boolean;
  signedAt?: Date | null;
  certValidAtSigning?: boolean;
  reason?: string;
}

/** Verifica la primera firma del PDF: integridad de lo firmado y firma RSA del certificado incluido. */
export function verifyPdfSignature(pdf: Buffer): SignatureReport {
  const text = pdf.toString('latin1');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!m) return { signed: false, valid: false, coversWholeFile: false };
  const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  const hexStart = pdf.indexOf('<', b);
  const hexEnd = pdf.indexOf('>', hexStart);
  if (a !== 0 || hexStart !== b || hexEnd + 1 !== c)
    return {
      signed: true,
      valid: false,
      coversWholeFile: false,
      reason: 'ByteRange inconsistente',
    };
  const coversWholeFile = c + d === pdf.length;
  try {
    const der = derFromContents(
      Buffer.from(pdf.subarray(hexStart + 1, hexEnd).toString('latin1'), 'hex'),
    );
    const signed = Buffer.concat([pdf.subarray(0, b), pdf.subarray(c, c + d)]);
    const p7 = forge.pkcs7.messageFromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary'))),
    ) as unknown as {
      certificates: forge.pki.Certificate[];
      rawCapture: {
        authenticatedAttributes: forge.asn1.Asn1[];
        signature: string;
        digestAlgorithm: string;
      };
    };
    const cert = p7.certificates[0];
    if (!cert) return { signed: true, valid: false, coversWholeFile, reason: 'sin certificado' };
    const attrs = p7.rawCapture.authenticatedAttributes;
    // Cada atributo es SEQUENCE { OID, SET { valor } }: se devuelve el primer valor del SET.
    const valueOf = (oid: string): forge.asn1.Asn1 | undefined => {
      const a = attrs.find(
        (x) => forge.asn1.derToOid((x.value as forge.asn1.Asn1[])[0]?.value as string) === oid,
      );
      const set = (a?.value as forge.asn1.Asn1[] | undefined)?.[1];
      return (set?.value as forge.asn1.Asn1[] | undefined)?.[0];
    };
    const digest = String(valueOf(forge.pki.oids.messageDigest ?? '')?.value ?? '');
    const expected = createHash('sha256').update(signed).digest();
    const digestOk = Buffer.from(digest, 'binary').equals(expected);
    // Los atributos firmados se codifican como SET para calcular la firma (RFC 5652).
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const attrDer = Buffer.from(forge.asn1.toDer(set).getBytes(), 'binary');
    const x509 = new X509Certificate(
      Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary'),
    );
    const sigOk = cryptoVerify(
      'sha256',
      attrDer,
      x509.publicKey,
      Buffer.from(p7.rawCapture.signature, 'binary'),
    );
    const info = certInfo(cert);
    const time = valueOf(forge.pki.oids.signingTime ?? '');
    const signedAt = time ? forge.asn1.utcTimeToDate(String(time.value)) : null;
    return {
      signed: true,
      valid: digestOk && sigOk,
      coversWholeFile,
      signer: info.subject,
      fingerprint: info.fingerprint,
      selfSigned: info.selfSigned,
      signedAt,
      certValidAtSigning: signedAt
        ? signedAt >= info.notBefore && signedAt <= info.notAfter
        : undefined,
      ...(digestOk && sigOk
        ? {}
        : {
            reason: digestOk
              ? 'la firma no coincide con el certificado'
              : 'el contenido cambió después de firmar',
          }),
    };
  } catch {
    return { signed: true, valid: false, coversWholeFile, reason: 'firma ilegible' };
  }
}
