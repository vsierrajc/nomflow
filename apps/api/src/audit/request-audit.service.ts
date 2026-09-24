import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { auditLogs } from '../db/schema';

export const HTTP_ACTION = 'HTTP_REQUEST';

export interface RequestRecord {
  actorAccountId: string | null;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  ip: string | null;
  userAgent: string | null;
  queryKeys: string[];
  requestId: string;
}

@Injectable()
export class RequestAuditService {
  private readonly logger = new Logger('RequestAudit');
  private readonly pending = new Set<Promise<void>>();

  constructor(@Inject(DB) private readonly db: Db) {}

  record(entry: RequestRecord): void {
    const job = this.db
      .insert(auditLogs)
      .values({
        actorAccountId: entry.actorAccountId,
        action: HTTP_ACTION,
        resource: entry.route,
        result: String(entry.status),
        context: {
          method: entry.method,
          durationMs: entry.durationMs,
          ip: entry.ip,
          userAgent: entry.userAgent,
          queryKeys: entry.queryKeys,
          requestId: entry.requestId,
        },
      })
      .then(() => undefined)
      .catch(() => {
        this.logger.error('No se pudo registrar la petición en la auditoría');
      })
      .finally(() => {
        this.pending.delete(job);
      });
    this.pending.add(job);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
