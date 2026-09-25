import {
  BadRequestException,
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
  UseGuards,
} from '@nestjs/common';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { OBJECT_STORE, ObjectStoreError, type ObjectStore } from '../storage/object-store';
import { getMine, listAll, listMine, processInbox } from './tax.service';

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
}
