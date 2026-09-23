import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

export function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}
