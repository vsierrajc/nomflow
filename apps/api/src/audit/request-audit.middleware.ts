import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RequestAuditService } from './request-audit.service';

const SKIPPED = new Set(['/health']);
const UNMATCHED = '(ruta no encontrada)';

function routeTemplate(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : UNMATCHED;
}

@Injectable()
export class RequestAuditMiddleware implements NestMiddleware {
  constructor(private readonly audit: RequestAuditService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (SKIPPED.has((req.originalUrl.split('?')[0] ?? '').replace(/\/+$/, ''))) {
      next();
      return;
    }
    const started = process.hrtime.bigint();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const auth = (req as Request & { auth?: { accountId: string } }).auth;
      this.audit.record({
        actorAccountId: auth?.accountId ?? null,
        method: req.method,
        route: routeTemplate(req),
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
        queryKeys: Object.keys(req.query).slice(0, 20),
        requestId,
      });
    });
    next();
  }
}
