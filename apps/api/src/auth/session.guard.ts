import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { authenticateSession, isValidCsrf, type AuthContext } from './session.service';

export const SESSION_COOKIE = 'nf_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AuthedRequest = Request & { auth: AuthContext };

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? await authenticateSession(this.db, token) : null;
    if (!auth) throw new UnauthorizedException();
    if (!SAFE_METHODS.has(req.method)) {
      const csrf = req.headers['x-csrf-token'];
      if (!isValidCsrf(auth.sessionId, typeof csrf === 'string' ? csrf : undefined)) {
        throw new ForbiddenException();
      }
    }
    req.auth = auth;
    return true;
  }
}
