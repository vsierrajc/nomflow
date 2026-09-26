import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Delete,
  Header,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
  PayloadTooLargeException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { auditLogs, companies } from '../db/schema';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  KINDS,
  LetterheadError,
  MAX_LETTERHEAD_BYTES,
  letterheadImage,
  letterheadStatus,
  removeLetterhead,
  uploadLetterhead,
  type LetterheadKind,
} from '../org/letterhead.service';
import {
  LogoError,
  MAX_LOGO_BYTES,
  activateLogo,
  adminLogo,
  listLogos,
  resetLogo,
  uploadLogo,
} from '../org/logos.service';

const Fields = {
  nombre: z.string().trim().min(1).max(200),
  sigla: z.string().trim().min(1).max(30),
  direccion: z.string().trim().min(1).max(300),
};
const Mode = z.enum(['SIN_AJUSTE', 'ENTERO_SUPERIOR']);
const CreateDto = z.object({
  cEmp: z.string().trim().min(1).max(30),
  ...Fields,
  payrollDefaultMode: Mode.optional(),
});
const UpdateDto = z.object({
  ...Fields,
  active: z.boolean(),
  payrollDefaultMode: Mode.optional(),
  version: z.number().int().positive(),
});

@Controller('admin/companies')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class CompaniesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list() {
    return this.db.select().from(companies).orderBy(companies.cEmp);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const inserted = await this.db
      .insert(companies)
      .values(dto.data)
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (!row) throw new ConflictException();
    await this.db.insert(auditLogs).values({
      actorAccountId: req.auth.accountId,
      action: 'COMPANY_CREATE',
      resource: 'company',
      resourceId: row.id,
      result: 'SUCCESS',
    });
    return row;
  }

  @Put(':id')
  @UseGuards(RecentAuthGuard)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = UpdateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const { version, ...values } = dto.data;
    const updated = await this.db
      .update(companies)
      .set({ ...values, version: sql`${companies.version} + 1`, updatedAt: new Date() })
      .where(and(eq(companies.id, id), eq(companies.version, version)))
      .returning();
    const row = updated[0];
    if (!row) {
      const [exists] = await this.db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, id));
      if (!exists) throw new NotFoundException();
      throw new ConflictException({ code: 'VERSION_CONFLICT' });
    }
    await this.db.insert(auditLogs).values({
      actorAccountId: req.auth.accountId,
      action: 'COMPANY_UPDATE',
      resource: 'company',
      resourceId: id,
      result: 'SUCCESS',
    });
    return row;
  }

  @Post(':id/logo')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES + 1, files: 1 } }))
  async uploadLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthedRequest,
  ) {
    if (!file) throw new BadRequestException();
    try {
      return await uploadLogo(this.db, req.auth.accountId, id, file.buffer);
    } catch (e) {
      return mapLogoError(e);
    }
  }

  @Get(':id/logo')
  async logo(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    try {
      const logo = await adminLogo(this.db, id);
      res.setHeader('Content-Type', logo.contentType);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('ETag', `"${logo.sha256}"`);
      res.setHeader('X-Logo-Source', logo.source);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return new StreamableFile(logo.data);
    } catch (e) {
      return mapLogoError(e);
    }
  }

  @Get(':id/logos')
  @Header('Cache-Control', 'no-store')
  async logos(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await listLogos(this.db, id);
    } catch (e) {
      return mapLogoError(e);
    }
  }

  @Post(':id/logo/reset')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async reset(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    try {
      await resetLogo(this.db, req.auth.accountId, id);
    } catch (e) {
      mapLogoError(e);
    }
  }

  @Post(':id/logo/:logoId/activate')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('logoId', ParseUUIDPipe) logoId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    try {
      await activateLogo(this.db, req.auth.accountId, id, logoId);
    } catch (e) {
      mapLogoError(e);
    }
  }

  @Get(':id/letterhead')
  @Header('Cache-Control', 'no-store')
  async letterhead(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await letterheadStatus(this.db, id);
    } catch (e) {
      return mapLetterheadError(e);
    }
  }

  @Get(':id/letterhead/:kind')
  async letterheadFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      const img = await letterheadImage(this.db, id, parseKind(kind));
      res.setHeader('Content-Type', img.contentType);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('ETag', `"${img.sha256}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return new StreamableFile(img.data);
    } catch (e) {
      return mapLetterheadError(e);
    }
  }

  @Post(':id/letterhead/:kind')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_LETTERHEAD_BYTES + 1, files: 1 } }),
  )
  async uploadLetterhead(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthedRequest,
  ) {
    if (!file) throw new BadRequestException();
    try {
      return await uploadLetterhead(this.db, req.auth.accountId, id, parseKind(kind), file.buffer);
    } catch (e) {
      return mapLetterheadError(e);
    }
  }

  @Delete(':id/letterhead/:kind')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async deleteLetterhead(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    try {
      await removeLetterhead(this.db, req.auth.accountId, id, parseKind(kind));
    } catch (e) {
      mapLetterheadError(e);
    }
  }
}

function parseKind(kind: string): LetterheadKind {
  const k = kind.toUpperCase();
  if (!(KINDS as readonly string[]).includes(k)) throw new NotFoundException();
  return k as LetterheadKind;
}

function mapLetterheadError(e: unknown): never {
  if (!(e instanceof LetterheadError)) throw e;
  switch (e.code) {
    case 'COMPANY_NOT_FOUND':
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'TOO_LARGE':
      throw new PayloadTooLargeException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

function mapLogoError(e: unknown): never {
  if (!(e instanceof LogoError)) throw e;
  switch (e.code) {
    case 'COMPANY_NOT_FOUND':
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'TOO_LARGE':
      throw new PayloadTooLargeException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}
