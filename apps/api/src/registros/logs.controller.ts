import { Readable } from 'node:stream';
import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import { LogError, LogsService, type AuditKind } from './logs.service';

const Kind = z.enum(['HTTP', 'EVENTOS', 'TODO']).default('TODO');
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Confirm = z.literal('BORRAR');

function map(e: unknown): never {
  if (!(e instanceof LogError)) throw e;
  const body = { code: e.code, detail: e.detail };
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException(body);
    case 'COLD_NOT_CONFIGURED':
    case 'NO_KEY':
      throw new ConflictException(body);
    case 'ARCHIVE_FAILED':
      throw new BadGatewayException(body);
    case 'TOO_LARGE':
      throw new HttpException(body, 413);
    default:
      throw new BadRequestException(body);
  }
}

/** Gestión de registros (auditoría y archivos de la aplicación): solo administradores. Ver ADR-006. */
@Controller('admin/logs')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminLogsController {
  constructor(@Inject(LogsService) private readonly logs: LogsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  summary() {
    return this.logs.summary();
  }

  @Put('settings')
  @UseGuards(RecentAuthGuard)
  async settings(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z
      .object({
        retentionDays: z.number().int(),
        httpRetentionDays: z.number().int(),
        archiveBeforePurge: z.boolean(),
        autoEnabled: z.boolean(),
      })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID' });
    try {
      return await this.logs.saveSettings(req.auth.accountId, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  // ----- auditoría en la base de datos -----

  @Get('audit/export')
  @Header('Cache-Control', 'no-store')
  async export(@Query() query: unknown, @Req() req: AuthedRequest) {
    const q = z
      .object({
        from: Day.optional(),
        to: Day.optional(),
        kind: Kind,
        format: z.enum(['csv', 'jsonl']).default('csv'),
      })
      .safeParse(query);
    if (!q.success) throw new BadRequestException({ code: 'INVALID' });
    const range = { from: q.data.from, to: q.data.to, kind: q.data.kind as AuditKind };
    const count = await this.logs.countRange(range);
    await this.logs.recordEvent(req.auth.accountId, 'LOG_EXPORT', 'SUCCESS', {
      ...range,
      format: q.data.format,
      rows: count,
    });
    const ext = q.data.format === 'csv' ? 'csv' : 'jsonl';
    return new StreamableFile(Readable.from(this.logs.exportChunks(range, q.data.format)), {
      type: q.data.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
      disposition: `attachment; filename="auditoria-${(q.data.kind as string).toLowerCase()}-${q.data.from ?? 'inicio'}-${q.data.to ?? 'hoy'}.${ext}"`,
    });
  }

  @Post('audit/archive')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async archive(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z.object({ from: Day.optional(), to: Day.optional(), kind: Kind }).safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID' });
    try {
      return await this.logs.archiveAudit(req.auth.accountId, {
        from: dto.data.from,
        to: dto.data.to,
        kind: dto.data.kind as AuditKind,
      });
    } catch (e) {
      return map(e);
    }
  }

  @Post('audit/purge')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async purge(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z
      .object({
        before: Day,
        kind: Kind,
        archive: z.boolean(),
        reason: z.string().trim().min(10).max(300),
        confirm: Confirm,
      })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'CONFIRM_REQUIRED' });
    try {
      return await this.logs.purgeAudit(req.auth.accountId, {
        before: dto.data.before,
        kind: dto.data.kind as AuditKind,
        archive: dto.data.archive,
        reason: dto.data.reason,
      });
    } catch (e) {
      return map(e);
    }
  }

  @Post('maintenance/run')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async run(@Req() req: AuthedRequest) {
    try {
      const r = await this.logs.runMaintenance(req.auth.accountId);
      await this.logs.recordRun('OK', `Archivados ${r.archived}, depurados ${r.purged}.`);
      return r;
    } catch (e) {
      await this.logs.recordRun(
        'ERROR',
        e instanceof LogError ? `${e.code} ${e.detail ?? ''}` : (e as Error).message,
      );
      return map(e);
    }
  }

  // ----- copias en el histórico -----

  @Get('archives')
  @Header('Cache-Control', 'no-store')
  async archives() {
    return { archives: await this.logs.listArchives(100) };
  }

  @Get('archives/:id/download')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('id', ParseUUIDPipe) id: string) {
    try {
      const f = await this.logs.downloadArchive(id);
      return new StreamableFile(f.data, {
        type: 'application/gzip',
        disposition: `attachment; filename="${f.fileName}"`,
      });
    } catch (e) {
      return map(e);
    }
  }

  // ----- archivos de registro de la aplicación -----

  @Get('files/:name/tail')
  @Header('Cache-Control', 'no-store')
  async tail(@Param('name') name: string, @Query() query: unknown) {
    const q = z
      .object({
        lines: z.coerce.number().int().min(10).max(2000).default(300),
        q: z.string().max(100).optional(),
      })
      .safeParse(query);
    if (!q.success) throw new BadRequestException({ code: 'INVALID' });
    try {
      return await this.logs.tail(name, q.data.lines, q.data.q);
    } catch (e) {
      return map(e);
    }
  }

  @Get('files/:name/download')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async fileDownload(@Param('name') name: string, @Req() req: AuthedRequest) {
    try {
      const stream = this.logs.fileStream(name);
      await this.logs.recordEvent(req.auth.accountId, 'LOG_EXPORT', 'SUCCESS', { file: name });
      return new StreamableFile(stream, {
        type: 'text/plain; charset=utf-8',
        disposition: `attachment; filename="${name}.log"`,
      });
    } catch (e) {
      return map(e);
    }
  }

  @Post('files/:name/archive')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async fileArchive(@Param('name') name: string, @Req() req: AuthedRequest) {
    try {
      return await this.logs.archiveFile(req.auth.accountId, name);
    } catch (e) {
      return map(e);
    }
  }

  @Post('files/:name/truncate')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async fileTruncate(
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = z
      .object({
        archiveFirst: z.boolean(),
        reason: z.string().trim().min(10).max(300),
        confirm: Confirm,
      })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'CONFIRM_REQUIRED' });
    try {
      return await this.logs.truncateFile(req.auth.accountId, name, dto.data);
    } catch (e) {
      return map(e);
    }
  }
}
