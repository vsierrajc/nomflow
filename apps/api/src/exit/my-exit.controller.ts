import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { accounts, auditLogs, documentExportDownloads, documentExports } from '../db/schema';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store';

@Controller('me/exit')
@UseGuards(SessionGuard)
export class MyExitController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  private async myNIde(accountId: string): Promise<string | null> {
    const [a] = await this.db
      .select({ nIde: accounts.nIde })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return a?.nIde ?? null;
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(@Req() req: AuthedRequest) {
    const nIde = await this.myNIde(req.auth.accountId);
    if (!nIde) return { export: null };
    const [exp] = await this.db
      .select()
      .from(documentExports)
      .where(eq(documentExports.nIde, nIde))
      .orderBy(desc(documentExports.requestedAt))
      .limit(1);
    if (!exp) return { export: null };
    return {
      export: {
        status: exp.status,
        readyAt: exp.readyAt,
        expiresAt: exp.expiresAt,
        available:
          ['LISTO', 'INCOMPLETO'].includes(exp.status) &&
          !!exp.expiresAt &&
          exp.expiresAt.getTime() > Date.now(),
      },
    };
  }

  @Get('export/download')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Req() req: AuthedRequest): Promise<StreamableFile> {
    const nIde = await this.myNIde(req.auth.accountId);
    if (!nIde) throw new NotFoundException();
    const [exp] = await this.db
      .select()
      .from(documentExports)
      .where(eq(documentExports.nIde, nIde))
      .orderBy(desc(documentExports.requestedAt))
      .limit(1);
    if (!exp || !['LISTO', 'INCOMPLETO'].includes(exp.status) || !exp.objectKey)
      throw new NotFoundException();
    if (!exp.expiresAt || exp.expiresAt.getTime() < Date.now()) throw new NotFoundException();
    const data = await this.store.get(exp.objectKey);
    if (!data) throw new NotFoundException();
    await this.db.insert(documentExportDownloads).values({
      exportId: exp.id,
      downloadedBy: req.auth.accountId,
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    await this.db.insert(auditLogs).values({
      actorAccountId: req.auth.accountId,
      action: 'EXIT_EXPORT_DOWNLOAD',
      resource: 'document_export',
      resourceId: exp.id,
      result: 'SUCCESS',
      context: { nIde, self: true },
    });
    return new StreamableFile(data, {
      type: 'application/zip',
      disposition: `attachment; filename="mi-documentacion.zip"`,
    });
  }
}
