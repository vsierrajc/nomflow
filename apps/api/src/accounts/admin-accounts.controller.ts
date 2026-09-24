import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { MAILER, type Mailer } from '../mail/mailer';
import { AccountError, createAccountByAdmin } from './accounts.service';
import {
  AccountAdminError,
  blockAccount,
  listAccounts,
  resetAccountPassword,
  unblockAccount,
} from './accounts-admin.service';

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['PENDIENTE_VERIFICACION', 'ACTIVA', 'BLOQUEADA']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function mapAdmin(e: unknown): never {
  if (!(e instanceof AccountAdminError)) throw e;
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'SELF':
    case 'FORBIDDEN':
      throw new ForbiddenException({ code: e.code });
    case 'CONFLICT':
    case 'NOT_BLOCKED':
      throw new ConflictException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

const CreateAccountDto = z.object({ nIde: z.string().trim().min(3).max(30) });

@Controller('admin/accounts')
@UseGuards(SessionGuard, RolesGuard, RecentAuthGuard)
@Roles(...ADMIN_ROLES)
export class AdminAccountsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async create(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<{ accountId: string; temporaryPassword: string; verificationSent: boolean }> {
    const dto = CreateAccountDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createAccountByAdmin(this.db, req.auth.accountId, dto.data.nIde, this.mailer);
    } catch (e) {
      if (!(e instanceof AccountError)) throw e;
      switch (e.code) {
        case 'FORBIDDEN':
          throw new ForbiddenException();
        case 'EMPLOYEE_NOT_FOUND':
          throw new NotFoundException();
        case 'ACCOUNT_EXISTS':
          throw new ConflictException();
        default:
          throw new UnprocessableEntityException({ code: e.code });
      }
    }
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown) {
    const q = ListQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    return listAccounts(this.db, q.data);
  }

  @Post(':id/block')
  @HttpCode(204)
  async block(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest): Promise<void> {
    try {
      await blockAccount(this.db, req.auth.accountId, id);
    } catch (e) {
      mapAdmin(e);
    }
  }

  @Post(':id/unblock')
  @HttpCode(200)
  async unblock(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      return await unblockAccount(this.db, req.auth.accountId, id);
    } catch (e) {
      return mapAdmin(e);
    }
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reset(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      return await resetAccountPassword(this.db, req.auth.accountId, id, this.mailer);
    } catch (e) {
      return mapAdmin(e);
    }
  }
}
