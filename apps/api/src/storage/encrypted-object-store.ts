import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ObjectStoreError, type ObjectStore } from './object-store';

const MAGIC = Buffer.from('NF1'); // versión del formato: permite cambiar el cifrado más adelante
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Cifra cada objeto en la aplicación antes de subirlo (AES-256-GCM). Garage acepta el encabezado de
 * cifrado del servidor pero no cifra, así que no se puede confiar en él.
 * La clave del objeto (su nombre) va como dato autenticado: un objeto copiado con otro nombre no descifra.
 * Formato: NF1 | iv (12) | etiqueta (16) | texto cifrado.
 */
export class EncryptedObjectStore implements ObjectStore {
  private readonly key: Buffer;

  constructor(
    private readonly inner: ObjectStore,
    secret: string,
  ) {
    if (secret.length < 32)
      throw new Error('La clave de cifrado de objetos debe tener 32+ caracteres');
    this.key = createHash('sha256').update(`nomflow-objects:v1:${secret}`).digest();
  }

  async put(name: string, data: Buffer, contentType?: string): Promise<void> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    await this.inner.put(name, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]), contentType);
  }

  async get(name: string): Promise<Buffer | null> {
    const raw = await this.inner.get(name);
    if (raw === null) return null;
    const header = MAGIC.length + IV_LENGTH + TAG_LENGTH;
    if (raw.length < header || !raw.subarray(0, MAGIC.length).equals(MAGIC))
      throw new ObjectStoreError('INTEGRITY');
    try {
      const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
      const tag = raw.subarray(MAGIC.length + IV_LENGTH, header);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(raw.subarray(header)), decipher.final()]);
    } catch {
      throw new ObjectStoreError('INTEGRITY');
    }
  }
}

/** Clave de cifrado: solo OBJECT_ENCRYPTION_KEY (nunca SESSION_SECRET: rotar una no debe inutilizar la otra). */
export function objectEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.OBJECT_ENCRYPTION_KEY || '';
}
