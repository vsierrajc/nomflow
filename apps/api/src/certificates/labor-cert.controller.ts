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
  UploadedFile,
  UseInterceptors,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
  verifyIssued,
} from './labor-cert.service';
import {
  MAX_SIGNATURE_BYTES,
  SignerError,
  addSigner,
  enrollDigitalGenerate,
  enrollDigitalUpload,
  enrollSignature,
  listSigners,
  signerCandidates,
  mySigners,
  ownCertificatePem,
  ownSignatureImage,
  removeDigital,
  updateSigner,
} from './signers.service';
import { VARIABLES } from './template-engine';

const Kind = z.enum(['GENERAL', 'DIRIGIDO']);

function map(e: unknown): never {
  if (e instanceof ObjectStoreError) {
    if (e.code === 'INTEGRITY')
      throw new InternalServerErrorException({ code: 'STORAGE_INTEGRITY' });
    throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE' });
  }
  if (e instanceof SignerError) {
    const b = { code: e.code };
    if (
      e.code === 'NOT_FOUND' ||
      e.code === 'NOT_A_SIGNER' ||
      e.code === 'ACCOUNT_NOT_FOUND' ||
      e.code === 'COMPANY_NOT_FOUND'
    )
      throw new NotFoundException(b);
    if (e.code === 'ALREADY_SIGNER') throw new ConflictException(b);
    if (e.code === 'NO_DIGITAL') throw new NotFoundException(b);
    throw new BadRequestException(b);
  }
  if (!(e instanceof CertError)) throw e;
  const body = { code: e.code, details: e.details };
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException(body);
    case 'NO_ACTIVE_CONTRACT':
    case 'NO_SIGNER':
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
      .object({
        kind: Kind.optional(),
        addressee: z.string().max(400).optional(),
        signerId: z.string().uuid().optional(),
      })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_REQUEST' });
    try {
      return await issue(this.db, this.store, req.auth.accountId, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  /** Estado de la firma del certificado: huella del archivo y validez de la firma digital si la lleva. */
  @Get(':id/verify')
  @Header('Cache-Control', 'no-store')
  async verify(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      return await verifyIssued(this.db, this.store, req.auth.accountId, id, false);
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

/** La persona designada como firmante carga su firma y autoriza su uso. */
@Controller('me/certificate-signer')
@UseGuards(SessionGuard)
export class MeCertificateSignerController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return mySigners(this.db, req.auth.accountId);
  }

  @Post(':id/signature')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_SIGNATURE_BYTES + 1, files: 1 } }),
  )
  async enroll(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { consent?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!file) throw new BadRequestException({ code: 'INVALID_IMAGE' });
    try {
      await enrollSignature(this.db, req.auth.accountId, id, file.buffer, body?.consent === 'true');
      return { ok: true };
    } catch (e) {
      return map(e);
    }
  }

  /** Sube el propio certificado digital (.p12/.pfx) con su clave. */
  @Post(':id/digital')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 64 * 1024 + 1, files: 1 } }))
  async digitalUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { passphrase?: string; consent?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!file) throw new BadRequestException({ code: 'INVALID_P12' });
    try {
      return await enrollDigitalUpload(
        this.db,
        req.auth.accountId,
        id,
        file.buffer,
        body?.passphrase ?? '',
        body?.consent === 'true',
      );
    } catch (e) {
      return map(e);
    }
  }

  /** NOMFLOW genera un certificado autofirmado para pruebas o uso interno. */
  @Post(':id/digital/generate')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async digitalGenerate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = z.object({ consent: z.boolean() }).safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'CONSENT_REQUIRED' });
    try {
      return await enrollDigitalGenerate(this.db, req.auth.accountId, id, dto.data.consent);
    } catch (e) {
      return map(e);
    }
  }

  @Post(':id/digital/remove')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async digitalRemove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await removeDigital(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      return map(e);
    }
  }

  /** Solo el certificado público (.pem), nunca la clave privada. */
  @Get(':id/digital/certificate')
  @Header('Cache-Control', 'no-store')
  async digitalCertificate(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      const pem = await ownCertificatePem(this.db, req.auth.accountId, id);
      return new StreamableFile(Buffer.from(pem), {
        type: 'application/x-pem-file',
        disposition: 'attachment; filename="certificado-firmante.pem"',
      });
    } catch (e) {
      return map(e);
    }
  }

  @Get(':id/signature')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async image(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      const f = await ownSignatureImage(this.db, req.auth.accountId, id);
      return new StreamableFile(f.data, { type: f.contentType, disposition: 'inline' });
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
  footerText: z.string().max(500),
  maxPerDay: z.number().int(),
  requireDigital: z.boolean().default(false),
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

  @Get('history/:id/verify')
  @Header('Cache-Control', 'no-store')
  async historyVerify(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      return await verifyIssued(this.db, this.store, req.auth.accountId, id, true);
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

  @Get('signers/:cEmp')
  @Header('Cache-Control', 'no-store')
  async signers(@Param('cEmp') cEmp: string) {
    await this.company(cEmp);
    return listSigners(this.db, cEmp);
  }

  /** Personas que se pueden designar como firmantes (para elegirlas de una lista). */
  @Get('signers/:cEmp/candidates')
  @Header('Cache-Control', 'no-store')
  async candidates(@Param('cEmp') cEmp: string) {
    await this.company(cEmp);
    return signerCandidates(this.db, cEmp);
  }

  @Post('signers/:cEmp')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async addSigner(@Param('cEmp') cEmp: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z
      .object({
        nIde: z.string().trim().min(1).max(30),
        title: z.string().max(100),
        tier: z.enum(['PRINCIPAL', 'RESPALDO']),
      })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SIGNER' });
    try {
      return await addSigner(this.db, req.auth.accountId, { cEmp, ...dto.data });
    } catch (e) {
      return map(e);
    }
  }

  @Put('signers/:cEmp/:id')
  @UseGuards(RecentAuthGuard)
  async updateSigner(
    @Param('cEmp') cEmp: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    await this.company(cEmp);
    const dto = z
      .object({
        title: z.string().max(100).optional(),
        tier: z.enum(['PRINCIPAL', 'RESPALDO']).optional(),
        active: z.boolean().optional(),
      })
      .safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SIGNER' });
    try {
      await updateSigner(this.db, req.auth.accountId, id, dto.data);
      return listSigners(this.db, cEmp);
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
