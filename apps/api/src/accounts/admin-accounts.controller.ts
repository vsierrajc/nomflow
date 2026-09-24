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
import { TwoFactorError, disableByAdmin } from '../auth/two-factor.service';
import { MAILER, type Mailer } from '../mail/mailer';
import { AccountError, createAccountByAdmin } from './accounts.service';
import {
  AccountAdminError,
  accountOfEmployee,
  blockAccount,
  listAccounts,
  resetAccountPassword,
  setAccountPassword,
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
    case 'WEAK_PASSWORD':
      throw new BadRequestException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

const CreateAccountDto = z.object({
  nIde: z.string().trim().min(3).max(30),
  /** Opcional: si no viene, el sistema genera una clave temporal. */
  password: z.string().min(1).max(200).optional(),
});
const SetPasswordDto = z.object({
  password: z.string().min(1).max(200),
  requireChange: z.boolean().default(true),
});

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
      return await createAccountByAdmin(
        this.db,
        req.auth.accountId,
        dto.data.nIde,
        this.mailer,
        dto.data.password,
      );
    } catch (e) {
      if (!(e instanceof AccountError)) throw e;
      switch (e.code) {
        case 'FORBIDDEN':
          throw new ForbiddenException();
        case 'EMPLOYEE_NOT_FOUND':
          throw new NotFoundException();
        case 'ACCOUNT_EXISTS':
          throw new ConflictException();
        case 'WEAK_PASSWORD':
          throw new BadRequestException({ code: e.code });
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

  /** Estado de la cuenta de acceso de un empleado (usuario, estado y doble paso). */
  @Get('by-employee/:nIde')
  @Header('Cache-Control', 'no-store')
  async byEmployee(@Param('nIde') nIde: string) {
    if (!nIde || nIde.length > 30) throw new BadRequestException();
    try {
      return await accountOfEmployee(this.db, nIde);
    } catch (e) {
      return mapAdmin(e);
    }
  }

  /** Asigna una clave elegida por el administrador. No se devuelve ni se registra. */
  @Post(':id/set-password')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async setPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = SetPasswordDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'WEAK_PASSWORD' });
    try {
      return await setAccountPassword(this.db, req.auth.accountId, id, dto.data, this.mailer);
    } catch (e) {
      return mapAdmin(e);
    }
  }

  /** Recuperación: desactiva el doble paso de un empleado que perdió el acceso a su correo. */
  @Post(':id/two-factor/disable')
  @HttpCode(200)
  async disableTwoFactor(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    if (id === req.auth.accountId) throw new ForbiddenException({ code: 'SELF' });
    try {
      await disableByAdmin(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      if (e instanceof TwoFactorError) {
        if (e.code === 'NOT_FOUND') throw new NotFoundException();
        throw new ConflictException({ code: e.code });
      }
      throw e;
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
