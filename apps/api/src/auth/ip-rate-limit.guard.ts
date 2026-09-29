import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

const RATE_LIMIT_KEY = 'nomflow:rateLimit';

interface RateLimitOptions {
  max: number;
  windowMs: number;
}

/** Límite de peticiones por IP a un endpoint público, dentro de una ventana de tiempo. */
export const RateLimit = (max: number, windowMs: number) =>
  SetMetadata(RATE_LIMIT_KEY, { max, windowMs } satisfies RateLimitOptions);

interface Bucket {
  count: number;
  resetAt: number;
}

// Contador en memoria por proceso: suficiente para una sola instancia de la API (igual límite que
// hoy asume el resto del proyecto, p. ej. el monitor de salud, sin depender de Redis).
const buckets = new Map<string, Bucket>();
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

function ensureCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60_000);
  cleanupTimer.unref();
}

@Injectable()
export class IpRateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;
    ensureCleanup();

    const req = context.switchToHttp().getRequest<Request>();
    const key = `${context.getClass().name}:${context.getHandler().name}:${req.ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }
    if (bucket.count >= options.max) {
      throw new HttpException({ code: 'RATE_LIMITED' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    bucket.count += 1;
    return true;
  }
}
