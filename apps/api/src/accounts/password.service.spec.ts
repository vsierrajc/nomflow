import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword, hashPassword, verifyPassword } from './password.service';

describe('password.service', () => {
  it('usa Argon2id y verifica la clave correcta', async () => {
    const h = await hashPassword('Clave-Segura-1');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'Clave-Segura-1')).toBe(true);
    expect(await verifyPassword(h, 'otra')).toBe(false);
  });

  it('rechaza un hash inválido sin lanzar', async () => {
    expect(await verifyPassword('no-es-hash', 'x')).toBe(false);
  });

  it('genera claves temporales distintas y suficientemente largas', () => {
    const a = generateTemporaryPassword();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).not.toEqual(generateTemporaryPassword());
  });
});
