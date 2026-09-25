import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EncryptedObjectStore } from './encrypted-object-store';
import { MemoryObjectStore } from './memory-object-store';
import { ObjectStoreError, UnconfiguredObjectStore } from './object-store';
import { s3ConfigFromEnv } from './s3-object-store';
import { createObjectStore } from './storage.module';

const SECRET = 'clave-de-objetos-de-prueba-con-mas-de-32-caracteres';
const PDF = Buffer.from('%PDF-1.4\nCertificado de retención de PRUEBA 123456\n%%EOF\n');

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ObjectStoreError).code;
  }
  return null;
};

describe('cifrado de objetos en la aplicación', () => {
  it('guarda cifrado y devuelve el original', async () => {
    const raw = new MemoryObjectStore();
    const store = new EncryptedObjectStore(raw, SECRET);
    await store.put('doc/uno.pdf', PDF, 'application/pdf');
    const stored = raw.objects.get('doc/uno.pdf');
    expect(stored?.contentType).toBe('application/pdf');
    expect(stored?.data.subarray(0, 3).toString()).toBe('NF1');
    expect(stored?.data.includes(Buffer.from('Certificado'))).toBe(false); // nada legible en el almacén
    expect(await store.get('doc/uno.pdf')).toEqual(PDF);
    expect(await store.get('doc/no-existe.pdf')).toBeNull();
  });

  it('cada objeto lleva un vector distinto, aunque el contenido sea igual', async () => {
    const raw = new MemoryObjectStore();
    const store = new EncryptedObjectStore(raw, SECRET);
    await store.put('a', PDF);
    await store.put('b', PDF);
    expect(raw.objects.get('a')?.data.equals(raw.objects.get('b')?.data ?? Buffer.alloc(0))).toBe(
      false,
    );
  });

  it('detecta un objeto alterado', async () => {
    const raw = new MemoryObjectStore();
    const store = new EncryptedObjectStore(raw, SECRET);
    await store.put('doc', PDF);
    const data = raw.objects.get('doc')?.data ?? Buffer.alloc(0);
    for (const at of [3, 20, data.length - 1]) {
      // cabecera del vector, etiqueta y cuerpo
      const copy = Buffer.from(data);
      copy[at] = (copy[at] ?? 0) ^ 0xff;
      raw.objects.set('doc', { data: copy, contentType: 'x' });
      expect(await code(store.get('doc')), `byte ${at}`).toBe('INTEGRITY');
    }
  });

  it('un objeto copiado con otro nombre no se descifra', async () => {
    const raw = new MemoryObjectStore();
    const store = new EncryptedObjectStore(raw, SECRET);
    await store.put('certificado-de-ana', PDF);
    raw.objects.set(
      'certificado-de-luis',
      raw.objects.get('certificado-de-ana') ?? { data: PDF, contentType: 'x' },
    );
    expect(await code(store.get('certificado-de-luis'))).toBe('INTEGRITY');
    expect(await store.get('certificado-de-ana')).toEqual(PDF);
  });

  it('otra clave, o un objeto sin cifrar, no se descifran', async () => {
    const raw = new MemoryObjectStore();
    await new EncryptedObjectStore(raw, SECRET).put('doc', PDF);
    expect(await code(new EncryptedObjectStore(raw, `${SECRET}-otra`).get('doc'))).toBe(
      'INTEGRITY',
    );
    raw.objects.set('plano', { data: PDF, contentType: 'x' });
    expect(await code(new EncryptedObjectStore(raw, SECRET).get('plano'))).toBe('INTEGRITY');
    raw.objects.set('corto', { data: Buffer.from('NF1'), contentType: 'x' });
    expect(await code(new EncryptedObjectStore(raw, SECRET).get('corto'))).toBe('INTEGRITY');
  });

  it('exige una clave larga', () => {
    expect(() => new EncryptedObjectStore(new MemoryObjectStore(), 'corta')).toThrow();
  });

  it('propaga que el almacén no responde', async () => {
    const raw = new MemoryObjectStore();
    const store = new EncryptedObjectStore(raw, SECRET);
    await store.put('doc', PDF);
    raw.down = true;
    expect(await code(store.put('otro', PDF))).toBe('UNAVAILABLE');
    expect(await code(store.get('doc'))).toBe('UNAVAILABLE');
  });
});

describe('configuración del almacén', () => {
  it('sin variables S3_* no hay almacén: falla de forma explícita y no cae a memoria', async () => {
    expect(s3ConfigFromEnv({})).toBeNull();
    for (const missing of [
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ]) {
      const env: NodeJS.ProcessEnv = {
        S3_ENDPOINT: 'http://x:3900',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
      };
      delete env[missing];
      expect(s3ConfigFromEnv(env), missing).toBeNull();
    }
    const store = createObjectStore({});
    expect(store).toBeInstanceOf(UnconfiguredObjectStore);
    expect(await code(store.put('k', PDF))).toBe('NOT_CONFIGURED');
    expect(await code(store.get('k'))).toBe('NOT_CONFIGURED');
  });

  it('sin OBJECT_ENCRYPTION_KEY (aunque haya SESSION_SECRET) el almacén queda sin configurar', () => {
    const base = {
      S3_ENDPOINT: 'http://localhost:3900',
      S3_BUCKET: 'nomflow-private',
      S3_ACCESS_KEY_ID: 'GKabc',
      S3_SECRET_ACCESS_KEY: 'secreto',
      SESSION_SECRET: 'x'.repeat(48),
    };
    expect(createObjectStore(base)).toBeInstanceOf(UnconfiguredObjectStore);
    expect(createObjectStore({ ...base, OBJECT_ENCRYPTION_KEY: 'corta' })).toBeInstanceOf(
      UnconfiguredObjectStore,
    );
    expect(
      createObjectStore({ ...base, OBJECT_ENCRYPTION_KEY: 'k'.repeat(40) }),
    ).not.toBeInstanceOf(UnconfiguredObjectStore);
  });

  it('con las variables, usa la región garage por omisión', () => {
    const cfg = s3ConfigFromEnv({
      S3_ENDPOINT: 'http://localhost:3900',
      S3_BUCKET: 'nomflow-private',
      S3_ACCESS_KEY_ID: 'GKabc',
      S3_SECRET_ACCESS_KEY: 'secreto',
    });
    expect(cfg).toMatchObject({ region: 'garage', bucket: 'nomflow-private' });
    expect(randomUUID()).toBeTruthy();
  });
});
