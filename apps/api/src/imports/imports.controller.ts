import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  ImportError,
  applyEmployeesBatch,
  getBatch,
  uploadEmployees,
  type BatchSummary,
} from './imports.service';

const MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES ?? 10 * 1024 * 1024);
const MAX_ROWS = Number(process.env.IMPORT_MAX_ROWS ?? 20000);

const UploadDto = z.object({
  sheet: z.string().trim().min(1).max(100).optional(),
  sourceSystem: z.string().trim().min(1).max(100),
  responsible: z.string().trim().min(1).max(150),
});

function mapError(e: unknown): never {
  if (!(e instanceof ImportError)) throw e;
  switch (e.code) {
    case 'NOT_XLSX':
      throw new BadRequestException({ code: e.code });
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'DUPLICATE_FILE':
    case 'NOT_READY':
      throw new ConflictException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

@Controller('admin/imports')
@UseGuards(SessionGuard, RolesGuard, RecentAuthGuard)
@Roles('HR_ADMIN')
export class ImportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post('employees')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async uploadEmployees(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<BatchSummary> {
    const dto = UploadDto.safeParse(body);
    if (!file || !dto.success) throw new BadRequestException();
    try {
      return await uploadEmployees(this.db, req.auth.accountId, {
        buffer: file.buffer,
        fileName: file.originalname,
        sheet: dto.data.sheet,
        sourceSystem: dto.data.sourceSystem,
        responsible: dto.data.responsible,
        maxRows: MAX_ROWS,
      });
    } catch (e) {
      return mapError(e);
    }
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<BatchSummary> {
    try {
      const b = await getBatch(this.db, id);
      return {
        id: b.id,
        status: b.status,
        rowCount: b.rowCount,
        errorCount: b.errorCount,
        stats: b.stats,
      };
    } catch (e) {
      return mapError(e);
    }
  }

  @Get(':id/errors')
  @Header('Cache-Control', 'no-store')
  async errors(@Param('id', ParseUUIDPipe) id: string) {
    try {
      const b = await getBatch(this.db, id);
      return { total: b.errorCount, shown: b.errors.length, errors: b.errors };
    } catch (e) {
      return mapError(e);
    }
  }

  @Post(':id/apply')
  @HttpCode(200)
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ): Promise<BatchSummary> {
    try {
      return await applyEmployeesBatch(this.db, req.auth.accountId, id);
    } catch (e) {
      return mapError(e);
    }
  }
}
