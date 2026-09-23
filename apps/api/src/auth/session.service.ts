import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, sessions } from '../db/schema';

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export interface SessionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export interface AuthContext {
  accountId: string;
  sessionId: string;
  authenticatedAt: Date;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET debe tener al menos 32 caracteres');
  return secret;
}

export function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', getSessionSecret()).update(sessionId).digest('hex');
}

export function isValidCsrf(sessionId: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(csrfTokenFor(sessionId));
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createSession(
  db: Db,
  accountId: string,
  meta: SessionMeta,
): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(sessions)
    .values({
      accountId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + ABSOLUTE_TIMEOUT_MS),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('sesión no creada');
  return { token, sessionId: row.id };
}

export async function authenticateSession(db: Db, token: string): Promise<AuthContext | null> {
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      accountId: sessions.accountId,
      lastSeenAt: sessions.lastSeenAt,
      createdAt: sessions.createdAt,
      reauthAt: sessions.reauthAt,
      status: accounts.status,
    })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    );
  if (!row || row.status !== 'ACTIVA') return null;
  if (now.getTime() - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
    await revokeSession(db, row.sessionId);
    return null;
  }
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  const authenticatedAt =
    row.reauthAt && row.reauthAt > row.createdAt ? row.reauthAt : row.createdAt;
  return { accountId: row.accountId, sessionId: row.sessionId, authenticatedAt };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeAllForAccount(db: Db, accountId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
}

export async function markReauthenticated(db: Db, sessionId: string): Promise<void> {
  await db.update(sessions).set({ reauthAt: new Date() }).where(eq(sessions.id, sessionId));
}
