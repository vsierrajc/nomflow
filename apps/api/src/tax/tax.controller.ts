import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  InternalServerErrorException,
  ServiceUnavailableException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { OBJECT_STORE, ObjectStoreError, type ObjectStore } from '../storage/object-store';
import {
  MAX_PDF_BYTES,
  getMine,
  listAll,
  listMine,
  processInbox,
  processUploads,
} from './tax.service';

@Controller('me/tax-certificates')
@UseGuards(SessionGuard)
export class MeTaxController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return listMine(this.db, req.auth.accountId);
  }

  @Get(':year/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(
    @Param('year') raw: string,
    @Query('inline') inline: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    if (!/^\d{4}$/.test(raw)) throw new BadRequestException();
    let cert;
    try {
      cert = await getMine(this.db, this.store, req.auth.accountId, Number(raw));
    } catch (e) {
      if (!(e instanceof ObjectStoreError)) throw e;
      // Sin almacén: reintentable (503). Alterado o perdido: no se entrega nada y se avisa al operador.
      if (e.code === 'INTEGRITY')
        throw new InternalServerErrorException({ code: 'STORAGE_INTEGRITY' });
      throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE' });
    }
    if (!cert) throw new NotFoundException();
    return new StreamableFile(cert.data, {
      type: 'application/pdf',
      disposition: `${inline === '1' ? 'inline' : 'attachment'}; filename="${cert.fileName}"`,
    });
  }
}

@Controller('admin/tax-certificates')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminTaxController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query('nIde') nIde: string | undefined) {
    return listAll(this.db, nIde?.trim() || undefined);
  }

  @Post('process')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async process(@Req() req: AuthedRequest) {
    return { results: await processInbox(this.db, this.store, req.auth.accountId) };
  }

  /** Alternativa a la carpeta del servidor: sube los PDF desde el navegador (hasta 50 por vez). */
  @Post('upload')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(FilesInterceptor('files', 50, { limits: { fileSize: MAX_PDF_BYTES + 1 } }))
  async upload(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: { nIde?: string; year?: string } | undefined,
    @Req() req: AuthedRequest,
  ) {
    if (!files || files.length === 0) throw new BadRequestException();
    const nIde = body?.nIde?.trim() ?? '';
    const year = Number(body?.year);
    const manual =
      nIde && /^[A-Za-z0-9]{1,30}$/.test(nIde) && Number.isInteger(year)
        ? { nIde, year }
        : undefined;
    if ((nIde || body?.year) && !manual) throw new BadRequestException();
    return {
      results: await processUploads(
        this.db,
        this.store,
        req.auth.accountId,
        files.map((f) => ({ name: f.originalname, buf: f.buffer })),
        manual,
      ),
    };
  }
}
