import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EncryptedObjectStore, objectEncryptionSecret } from './encrypted-object-store';
import { ObjectStoreError } from './object-store';
import { S3ObjectStore, s3ConfigFromEnv } from './s3-object-store';

/** Contra un Garage real. Se omite si no hay variables S3_* (p. ej. el job de verificación del CI). */
const config = s3ConfigFromEnv({
  ...process.env,
  S3_BUCKET: process.env.S3_TEST_BUCKET || process.env.S3_BUCKET,
});
const SECRET = objectEncryptionSecret() || 'clave-de-objetos-de-prueba-con-mas-de-32-caracteres';
const PDF = Buffer.from('%PDF-1.4\nRetención de PRUEBA 987654\n%%EOF\n');
const name = () => `test/${randomUUID()}.pdf`;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ObjectStoreError).code;
  }
  return null;
};

describe.skipIf(!config)('Garage real (API S3)', () => {
  // Perezoso: el cuerpo del describe se ejecuta aunque esté omitido y sin config no hay cliente.
  const raw = config ? new S3ObjectStore(config) : (null as unknown as S3ObjectStore);
  const store = new EncryptedObjectStore(raw, SECRET);

  it('borra un objeto (lo usa el archivado tras verificar la copia)', async () => {
    const key = name();
    await raw.put(key, Buffer.from('x'));
    await raw.delete(key);
    expect(await raw.get(key)).toBeNull();
  });

  it('guarda y recupera; un objeto inexistente es null', async () => {
    const key = name();
    await store.put(key, PDF, 'application/pdf');
    expect(await store.get(key)).toEqual(PDF);
    expect(await store.get(name())).toBeNull();
  });

  it('lo que queda en Garage está cifrado (no confiar en el cifrado del servidor)', async () => {
    const key = name();
    await store.put(key, PDF, 'application/pdf');
    const inGarage = await raw.get(key);
    expect(inGarage?.subarray(0, 3).toString()).toBe('NF1');
    expect(inGarage?.includes(Buffer.from('Retención'))).toBe(false);
  });

  it('un objeto alterado directamente en Garage se detecta', async () => {
    const key = name();
    await store.put(key, PDF);
    const tampered = Buffer.from((await raw.get(key)) ?? Buffer.alloc(0));
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await raw.put(key, tampered);
    expect(await code(store.get(key))).toBe('INTEGRITY');
  });

  it('un objeto sin cifrar puesto directamente en Garage no se acepta', async () => {
    const key = name();
    await raw.put(key, PDF);
    expect(await code(store.get(key))).toBe('INTEGRITY');
  });

  it('credenciales incorrectas o servidor caído: no disponible', async () => {
    const cfg = config as NonNullable<typeof config>;
    const wrongKey = new S3ObjectStore({ ...cfg, secretAccessKey: 'incorrecta' });
    expect(await code(wrongKey.get(name()))).toBe('UNAVAILABLE');
    expect(await code(wrongKey.put(name(), PDF))).toBe('UNAVAILABLE');
    const down = new S3ObjectStore({ ...cfg, endpoint: 'http://127.0.0.1:1' });
    expect(await code(down.get(name()))).toBe('UNAVAILABLE');
  });
});
