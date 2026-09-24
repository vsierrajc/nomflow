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
  Query,
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
import { applyConceptsBatch, uploadConcepts } from '../payroll/concepts.service';
import { CATALOGS, isCatalogKind } from './catalog.parser';
import {
  applyPayrollBatch,
  listPayrollVersions,
  uploadPayroll,
} from '../payroll/payroll-import.service';
import { applyCatalogBatch, listCatalog, uploadCatalog } from './catalogs.service';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
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

const PayrollUploadDto = z.object({
  per: z.string().regex(/^\d{6}$/),
  nLiq: z.enum(['1', '2']).transform(Number),
  sheet: z.string().trim().min(1).max(100).optional(),
  sourceSystem: z.string().trim().min(1).max(100),
  responsible: z.string().trim().min(1).max(150),
});

const UploadDto = z.object({
  cEmp: z.string().trim().min(1).max(30).optional(),
  sheet: z.string().trim().min(1).max(100).optional(),
  sourceSystem: z.string().trim().min(1).max(100),
  responsible: z.string().trim().min(1).max(150),
});

function mapError(e: unknown): never {
  if (!(e instanceof ImportError)) throw e;
  switch (e.code) {
    case 'NOT_XLSX':
    case 'COMPANY_REQUIRED':
    case 'INVALID_SCOPE':
    case 'UNKNOWN_CATALOG':
      throw new BadRequestException({ code: e.code });
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'DUPLICATE_FILE':
    case 'NOT_READY':
    case 'SAME_CONTENT':
      throw new ConflictException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

@Controller('admin/imports')
@UseGuards(SessionGuard, RolesGuard, RecentAuthGuard)
@Roles(...ADMIN_ROLES)
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

  @Post('concepts')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async uploadConcepts(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<BatchSummary> {
    const dto = UploadDto.safeParse(body);
    if (!file || !dto.success) throw new BadRequestException();
    try {
      return await uploadConcepts(this.db, req.auth.accountId, {
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

  @Post('payroll')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async uploadPayroll(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<BatchSummary> {
    const dto = PayrollUploadDto.safeParse(body);
    if (!file || !dto.success) throw new BadRequestException();
    try {
      return await uploadPayroll(this.db, req.auth.accountId, {
        buffer: file.buffer,
        fileName: file.originalname,
        sheet: dto.data.sheet,
        per: dto.data.per,
        nLiq: dto.data.nLiq,
        sourceSystem: dto.data.sourceSystem,
        responsible: dto.data.responsible,
        maxRows: MAX_ROWS,
      });
    } catch (e) {
      return mapError(e);
    }
  }

  @Get('payroll/versions')
  @Header('Cache-Control', 'no-store')
  async payrollVersions(@Query('per') per: string | undefined) {
    if (per !== undefined && !/^\d{6}$/.test(per)) throw new BadRequestException();
    return listPayrollVersions(this.db, per);
  }

  @Post('catalogs/:kind')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async uploadCatalog(
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<BatchSummary> {
    if (!isCatalogKind(kind)) throw new NotFoundException();
    const dto = UploadDto.safeParse(body);
    if (!file || !dto.success) throw new BadRequestException();
    try {
      return await uploadCatalog(this.db, req.auth.accountId, kind, {
        buffer: file.buffer,
        fileName: file.originalname,
        sheet: dto.data.sheet,
        cEmp: dto.data.cEmp,
        sourceSystem: dto.data.sourceSystem,
        responsible: dto.data.responsible,
        maxRows: MAX_ROWS,
      });
    } catch (e) {
      return mapError(e);
    }
  }

  @Get('catalogs/:kind')
  @Header('Cache-Control', 'no-store')
  async catalog(@Param('kind') kind: string, @Query('cEmp') cEmp: string | undefined) {
    if (!isCatalogKind(kind) || (!CATALOGS[kind].global && !cEmp)) throw new BadRequestException();
    return listCatalog(this.db, kind, cEmp ?? '');
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<BatchSummary> {
    try {
      const b = await getBatch(this.db, id);
      return {
        id: b.id,
        type: b.type,
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
      const batch = await getBatch(this.db, id);
      if (batch.type === 'NOMINA') return await applyPayrollBatch(this.db, req.auth.accountId, id);
      if (batch.type === 'CONCEPTO')
        return await applyConceptsBatch(this.db, req.auth.accountId, id);
      return isCatalogKind(batch.type)
        ? await applyCatalogBatch(this.db, req.auth.accountId, id)
        : await applyEmployeesBatch(this.db, req.auth.accountId, id);
    } catch (e) {
      return mapError(e);
    }
  }
}
