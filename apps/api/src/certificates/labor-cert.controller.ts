import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  StreamableFile,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { companies } from '../db/schema';
import { OBJECT_STORE, ObjectStoreError, type ObjectStore } from '../storage/object-store';
import {
  CertError,
  adminHistory,
  getPdf,
  getSettings,
  issue,
  listMine,
  listTemplates,
  optionsFor,
  preview,
  saveSettings,
  saveTemplate,
} from './labor-cert.service';
import { VARIABLES } from './template-engine';

const Kind = z.enum(['GENERAL', 'DIRIGIDO']);

function map(e: unknown): never {
  if (e instanceof ObjectStoreError) {
    if (e.code === 'INTEGRITY')
      throw new InternalServerErrorException({ code: 'STORAGE_INTEGRITY' });
    throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE' });
  }
  if (!(e instanceof CertError)) throw e;
  const body = { code: e.code, details: e.details };
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException(body);
    case 'NO_ACTIVE_CONTRACT':
      throw new ConflictException(body);
    case 'MISSING_DATA':
    case 'INVALID_TEMPLATE':
      throw new UnprocessableEntityException(body);
    case 'LIMIT_REACHED':
      throw new HttpException(body, 429);
    case 'INTEGRITY':
      throw new InternalServerErrorException({ code: 'STORAGE_INTEGRITY' });
    default:
      throw new BadRequestException(body);
  }
}

const pdfResponse = (data: Buffer, fileName: string, inline: boolean) =>
  new StreamableFile(data, {
    type: 'application/pdf',
    disposition: `${inline ? 'inline' : 'attachment'}; filename="${fileName}"`,
  });

/** Certificado laboral del propio empleado: se genera al momento, sin aprobación. */
@Controller('me/labor-certificates')
@UseGuards(SessionGuard)
export class MeLaborCertController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  @Get('options')
  @Header('Cache-Control', 'no-store')
  async options(@Req() req: AuthedRequest) {
    try {
      return await optionsFor(this.db, req.auth.accountId);
    } catch (e) {
      return map(e);
    }
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return listMine(this.db, req.auth.accountId);
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z
      .object({ kind: Kind.optional(), addressee: z.string().max(400).optional() })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_REQUEST' });
    try {
      return await issue(this.db, this.store, req.auth.accountId, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Get(':id/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('inline') inline: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    try {
      const f = await getPdf(this.db, this.store, req.auth.accountId, id, false);
      return pdfResponse(f.data, f.fileName, inline === '1');
    } catch (e) {
      return map(e);
    }
  }
}

const SettingsDto = z.object({
  mode: z.enum(['GENERAL', 'DIRIGIDO', 'AMBOS']),
  docCode: z.string().max(40),
  docVersion: z.string().max(20),
  docDate: z.string().max(40),
  city: z.string().max(80),
  signerName: z.string().max(100),
  signerTitle: z.string().max(100),
  footerText: z.string().max(500),
  maxPerDay: z.number().int(),
});
const TemplateDto = z.object({ title: z.string().max(200), body: z.string().max(8000) });
const HistoryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: Kind.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Historial, plantillas y parámetros del certificado laboral: solo administradores. */
@Controller('admin/labor-certificates')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminLaborCertController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  private async company(cEmp: string) {
    const [c] = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.cEmp, cEmp));
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND' });
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  history(@Query() query: unknown) {
    const q = HistoryQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    return adminHistory(this.db, q.data);
  }

  @Get('history/:id/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async historyPdf(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      const f = await getPdf(this.db, this.store, req.auth.accountId, id, true);
      return pdfResponse(f.data, f.fileName, false);
    } catch (e) {
      return map(e);
    }
  }

  @Get('config/:cEmp')
  @Header('Cache-Control', 'no-store')
  async config(@Param('cEmp') cEmp: string) {
    await this.company(cEmp);
    return {
      settings: await getSettings(this.db, cEmp),
      templates: await listTemplates(this.db, cEmp),
      variables: VARIABLES,
    };
  }

  @Put('config/:cEmp/settings')
  @UseGuards(RecentAuthGuard)
  async saveSettings(
    @Param('cEmp') cEmp: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    await this.company(cEmp);
    const dto = SettingsDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SETTINGS' });
    try {
      return await saveSettings(this.db, req.auth.accountId, cEmp, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Put('config/:cEmp/templates/:kind')
  @UseGuards(RecentAuthGuard)
  async saveTemplate(
    @Param('cEmp') cEmp: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    await this.company(cEmp);
    const k = Kind.safeParse(kind);
    const dto = TemplateDto.safeParse(body);
    if (!k.success || !dto.success) throw new BadRequestException({ code: 'INVALID_TEMPLATE' });
    try {
      return await saveTemplate(this.db, req.auth.accountId, cEmp, k.data, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  /** PDF de ensayo con datos ficticios, del borrador que se está editando o de la versión vigente. */
  @Post('config/:cEmp/templates/:kind/preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async preview(@Param('cEmp') cEmp: string, @Param('kind') kind: string, @Body() body: unknown) {
    await this.company(cEmp);
    const k = Kind.safeParse(kind);
    const dto = TemplateDto.optional().safeParse(
      body && Object.keys(body as object).length > 0 ? body : undefined,
    );
    if (!k.success || !dto.success) throw new BadRequestException({ code: 'INVALID_TEMPLATE' });
    try {
      return pdfResponse(await preview(this.db, cEmp, k.data, dto.data), 'vista-previa.pdf', true);
    } catch (e) {
      return map(e);
    }
  }
}
