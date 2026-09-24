import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Header,
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
}
