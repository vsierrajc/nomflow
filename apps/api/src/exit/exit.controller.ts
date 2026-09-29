import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { auditLogs, documentExportDownloads, documentExports } from '../db/schema';
import { OBJECT_STORE, type ObjectStore } from '../storage/object-store';
import { ExitNoticeService } from './exit-notice.service';
import {
  ExitScheduleError,
  cancelExit,
  listSchedules,
  scheduleExit,
} from './exit-schedule.service';
import { ExitSettingsError, getSettings, saveSettings } from './exit-settings.service';
import { ExportZipMonitor } from './export-zip.monitor';

const Reason = z.string().trim().min(10).max(500);
const ScheduleInput = z.object({
  nIde: z.string().trim().min(3).max(30),
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: Reason,
});
const SettingsInput = z.object({
  preBajaAvisoDias: z.number().int().min(0).max(90),
  zipExpiryDays: z.number().int().min(1).max(90),
});

@Controller('admin/exit')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class ExitController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(ExitNoticeService) private readonly notice: ExitNoticeService,
    @Inject(ExportZipMonitor) private readonly zipMonitor: ExportZipMonitor,
  ) {}

  /** Ejecuta de inmediato la revisión que normalmente hace el job periódico (igual que Salud). */
  @Post('notice/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  checkNow() {
    return this.notice.runOnce();
  }

  /** Arma de inmediato los ZIP pendientes, sin esperar al job periódico. */
  @Post('exports/generate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  generateNow() {
    return this.zipMonitor.runOnce();
  }

  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings() {
    return getSettings(this.db);
  }

  @Put('settings')
  @UseGuards(RecentAuthGuard)
  async saveSettings(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = SettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    try {
      await saveSettings(this.db, req.auth.accountId, parsed.data);
    } catch (e) {
      if (e instanceof ExitSettingsError) throw new BadRequestException({ code: e.code });
      throw e;
    }
    return getSettings(this.db);
  }

  @Get('schedule')
  @Header('Cache-Control', 'no-store')
  list(@Query('nIde') nIde: string | undefined) {
    return listSchedules(this.db, nIde);
  }

  @Post('schedule')
  @HttpCode(201)
  async schedule(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = ScheduleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    try {
      return await scheduleExit(this.db, req.auth.accountId, parsed.data);
    } catch (e) {
      if (e instanceof ExitScheduleError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }

  @Post('schedule/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id') id: string,
    @Body('reason') reason: unknown,
    @Req() req: AuthedRequest,
  ) {
    const why = Reason.safeParse(reason);
    if (!why.success) throw new BadRequestException();
    try {
      return await cancelExit(this.db, req.auth.accountId, id, why.data);
    } catch (e) {
      if (e instanceof ExitScheduleError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }

  @Get('exports')
  @Header('Cache-Control', 'no-store')
  async exports(@Query('nIde') nIde: string | undefined) {
    return this.db
      .select()
      .from(documentExports)
      .where(nIde ? eq(documentExports.nIde, nIde) : undefined)
      .orderBy(desc(documentExports.requestedAt));
  }

  @Post('exports')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async requestExport(
    @Body('nIde') nIdeRaw: unknown,
    @Body('reason') reasonRaw: unknown,
    @Req() req: AuthedRequest,
  ) {
    const nIde = z.string().trim().min(3).max(30).safeParse(nIdeRaw);
    const reason = Reason.safeParse(reasonRaw);
    if (!nIde.success || !reason.success) throw new BadRequestException();
    const [row] = await this.db
      .insert(documentExports)
      .values({
        requestedBy: req.auth.accountId,
        requestKind: 'ADMIN_ONDEMAND',
        reason: reason.data,
        nIde: nIde.data,
        status: 'PENDIENTE',
      })
      .returning();
    await this.db.insert(auditLogs).values({
      actorAccountId: req.auth.accountId,
      action: 'EXIT_EXPORT_REQUEST',
      resource: 'document_export',
      resourceId: row?.id ?? null,
      result: 'SUCCESS',
      context: { nIde: nIde.data, reason: reason.data },
    });
    return row;
  }

  @Get('exports/:id/download')
  @UseGuards(RecentAuthGuard)
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('id') id: string, @Req() req: AuthedRequest): Promise<StreamableFile> {
    const [exp] = await this.db.select().from(documentExports).where(eq(documentExports.id, id));
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
      context: { nIde: exp.nIde },
    });
    return new StreamableFile(data, {
      type: 'application/zip',
      disposition: `attachment; filename="baja-${exp.nIde}.zip"`,
    });
  }
}
