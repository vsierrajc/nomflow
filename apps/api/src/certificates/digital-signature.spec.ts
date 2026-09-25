import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DigitalSignatureError,
  derFromContents,
  generateSelfSigned,
  inspectP12,
  signPdf,
  verifyPdfSignature,
} from './digital-signature';
import { renderLaborCertificatePdf } from './labor-cert.pdf';

const base = {
  ref: 'AB12CD34',
  title: 'CERTIFICADO LABORAL',
  body: 'HACE CONSTAR\n\nQue PERSONA DE PRUEBA trabaja en la empresa.',
  company: { nombre: 'EMPRESA S.A.', sigla: 'E', direccion: 'CL 1 2-3' },
  logo: null,
  docCode: 'GH-FO-001',
  docVersion: '01',
  docDate: '',
  signer: { name: 'PERSONA DE PRUEBA', title: 'Cargo', signature: null },
  footerLines: [],
  issuedAt: new Date('2026-09-25T15:00:00Z'),
  digital: {
    reason: 'Certificado laboral',
    name: 'PERSONA DE PRUEBA',
    location: 'Barranquilla',
    contact: 'x@x.co',
  },
};

describe('firma digital del PDF', () => {
  const pass = 'clave-de-prueba-123';
  const made = generateSelfSigned({
    name: 'PERSONA DE PRUEBA',
    organization: 'EMPRESA S.A.',
    email: 'x@x.co',
    passphrase: pass,
  });

  it('genera un certificado autofirmado válido y lo reconoce', async () => {
    expect(made.info.selfSigned).toBe(true);
    expect(made.info.keyBits).toBe(2048);
    expect(made.info.subject).toContain('PERSONA DE PRUEBA');
    expect(made.info.notAfter.getTime()).toBeGreaterThan(Date.now() + 700 * 86_400_000);
    const seen = await inspectP12(made.p12, pass);
    expect(seen.fingerprint).toBe(made.info.fingerprint);
    await expect(inspectP12(made.p12, 'otra-clave')).rejects.toMatchObject({
      code: 'WRONG_PASSPHRASE',
    });
    await expect(inspectP12(Buffer.from('no es un p12'), pass)).rejects.toBeInstanceOf(
      DigitalSignatureError,
    );
  });

  it('firma el PDF y la firma se verifica; cualquier cambio la invalida', async () => {
    const pdf = await renderLaborCertificatePdf(base);
    expect(verifyPdfSignature(pdf)).toMatchObject({ signed: true, valid: false }); // reservado pero aún sin firmar
    const signed = await signPdf(pdf, made.p12, pass);
    expect(signed.subarray(0, 5).toString()).toBe('%PDF-');
    const ok = verifyPdfSignature(signed);
    expect(ok).toMatchObject({
      signed: true,
      valid: true,
      coversWholeFile: true,
      selfSigned: true,
      certValidAtSigning: true,
    });
    expect(ok.signer).toContain('PERSONA DE PRUEBA');
    expect(ok.fingerprint).toBe(made.info.fingerprint);
    expect(ok.signedAt).toBeInstanceOf(Date);

    // alterar un byte del contenido firmado invalida la firma
    const tampered = Buffer.from(signed);
    const at = tampered.indexOf('Producer');
    tampered[at] = tampered[at] === 0x50 ? 0x51 : 0x50;
    const bad = verifyPdfSignature(tampered);
    expect(bad.valid).toBe(false);
    expect(bad.reason).toContain('cambió');
    // añadir bytes al final: ya no cubre todo el archivo
    const appended = Buffer.concat([signed, Buffer.from('\n% añadido')]);
    expect(verifyPdfSignature(appended).coversWholeFile).toBe(false);
    // un PDF sin firma digital
    const plain = await renderLaborCertificatePdf({ ...base, digital: undefined });
    expect(verifyPdfSignature(plain)).toMatchObject({ signed: false, valid: false });
  });

  it('120 firmas seguidas se verifican todas (sin fallos esporádicos por el relleno o el largo)', async () => {
    for (let i = 0; i < 120; i++) {
      const signed = await signPdf(
        await renderLaborCertificatePdf({ ...base, ref: `R${i}`, body: `${base.body} ${i}` }),
        made.p12,
        pass,
      );
      const r = verifyPdfSignature(signed);
      expect(r.valid, `firma ${i}`).toBe(true);
      expect(r.coversWholeFile).toBe(true);
    }
  }, 60_000);

  it('el relleno de ceros no se confunde con una firma que termina en 0x00', () => {
    const der = Buffer.concat([
      Buffer.from([0x30, 0x82, 0x00, 0x05]),
      Buffer.from([1, 2, 3, 0x00, 0x00]),
    ]); // termina en ceros legítimos
    expect(derFromContents(Buffer.concat([der, Buffer.alloc(100)])).equals(der)).toBe(true);
    expect(() => derFromContents(Buffer.from([1, 2, 3]))).toThrow();
  });

  it('OpenSSL también valida la firma (independiente de nuestro verificador)', async () => {
    const signed = await signPdf(await renderLaborCertificatePdf(base), made.p12, pass);
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(
      signed.toString('latin1'),
    );
    const [b, c, d] = [Number(m?.[2]), Number(m?.[3]), Number(m?.[4])];
    const der = derFromContents(
      Buffer.from(signed.subarray(b + 1, c - 1).toString('latin1'), 'hex'),
    );
    const dir = mkdtempSync(join(tmpdir(), 'nf-sig-'));
    writeFileSync(join(dir, 'sig.der'), der);
    writeFileSync(
      join(dir, 'content.bin'),
      Buffer.concat([signed.subarray(0, b), signed.subarray(c, c + d)]),
    );
    const r = spawnSync(
      'openssl',
      [
        'cms',
        '-verify',
        '-inform',
        'DER',
        '-in',
        join(dir, 'sig.der'),
        '-content',
        join(dir, 'content.bin'),
        '-binary',
        '-noverify',
      ],
      { encoding: 'utf8' },
    );
    if (r.error) return; // sin openssl en el equipo: solo se omite esta comprobación adicional
    expect(r.stderr).toContain('Verification successful');
    // con un contenido distinto, OpenSSL la rechaza
    writeFileSync(join(dir, 'content.bin'), Buffer.from('otro contenido'));
    const bad = spawnSync(
      'openssl',
      [
        'cms',
        '-verify',
        '-inform',
        'DER',
        '-in',
        join(dir, 'sig.der'),
        '-content',
        join(dir, 'content.bin'),
        '-binary',
        '-noverify',
      ],
      { encoding: 'utf8' },
    );
    expect(bad.status).not.toBe(0);
  });
});
