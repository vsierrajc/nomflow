import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Clave de cifrado de secretos guardados: HOLIDAY_SETTINGS_KEY o, en su defecto, derivada de SESSION_SECRET. */
function key(): Buffer {
  const base = process.env.SETTINGS_ENCRYPTION_KEY ?? process.env.SESSION_SECRET ?? '';
  if (base.length < 32)
    throw new Error('Falta SETTINGS_ENCRYPTION_KEY o SESSION_SECRET (mínimo 32 caracteres)');
  return createHash('sha256').update(`nomflow-settings:${base}`).digest();
}

/** AES-256-GCM: devuelve iv.etiqueta.texto cifrado en base64. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !enc) throw new Error('secreto con formato inválido');
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
