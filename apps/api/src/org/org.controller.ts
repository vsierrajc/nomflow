import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { assignAreaManager, endAreaManager, listAreaManagers } from './area-managers.service';
import { OrgError, grantRole, listRoles } from './roles.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GrantDto = z.object({
  role: z.enum([
    'EMPLOYEE',
    'AREA_MANAGER',
    'VACATION_FINAL_APPROVER',
    'CERTIFICATE_APPROVER',
    'HR_ADMIN',
    'SYSTEM_ADMIN',
  ]),
  cEmp: z.string().trim().min(1).max(30).optional(),
  areaCode: z.string().trim().min(1).max(30).optional(),
  validFrom: date,
  validTo: date.nullable().optional(),
});
const AssignDto = z.object({
  cEmp: z.string().trim().min(1).max(30),
  cArea: z.string().trim().min(1).max(30),
  managerAccountId: z.string().uuid(),
  validFrom: date,
  validTo: date.nullable().optional(),
});
const EndDto = z.object({ validTo: date });

function map(e: unknown): never {
  if (!(e instanceof OrgError)) throw e;
  switch (e.code) {
    case 'FORBIDDEN':
    case 'SELF_GRANT':
      throw new ForbiddenException({ code: e.code });
    case 'ACCOUNT_NOT_FOUND':
    case 'AREA_NOT_FOUND':
    case 'NOT_FOUND':
      throw new NotFoundException({ code: e.code });
    case 'OVERLAP':
      throw new ConflictException({ code: e.code });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles('HR_ADMIN', 'SYSTEM_ADMIN')
export class OrgController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post('accounts/:id/roles')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async grant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = GrantDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await grantRole(this.db, req.auth.accountId, id, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Get('accounts/:id/roles')
  roles(@Param('id', ParseUUIDPipe) id: string) {
    return listRoles(this.db, id);
  }

  @Post('areas/managers')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async assign(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = AssignDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await assignAreaManager(this.db, req.auth.accountId, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Put('areas/managers/:id/end')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async end(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const dto = EndDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await endAreaManager(this.db, req.auth.accountId, id, dto.data.validTo);
    } catch (e) {
      map(e);
    }
  }

  @Get('areas/:cEmp/:cArea/managers')
  managers(@Param('cEmp') cEmp: string, @Param('cArea') cArea: string) {
    return listAreaManagers(this.db, cEmp, cArea);
  }
}
