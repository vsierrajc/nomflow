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
  UnprocessableEntityException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  VacationError,
  adminApproved,
  annulApproved,
  pendingFirstApproval,
  reassignApprover,
} from './vacation.service';

const Query_ = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['APROBADA', 'ANULADA']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Gestión Humana consulta los disfrutes aprobados y puede anular uno que aún no terminó. */
@Controller('admin/vacations')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminVacationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('approved')
  @Header('Cache-Control', 'no-store')
  approved(@Query() query: unknown) {
    const q = Query_.safeParse(query);
    if (!q.success) throw new BadRequestException();
    return adminApproved(this.db, q.data);
  }

  /** Solicitudes en espera del primer visto bueno y si su aprobador asignado sigue siendo el vigente. */
  @Get('pending-approval')
  @Header('Cache-Control', 'no-store')
  pendingApproval() {
    return pendingFirstApproval(this.db);
  }

  @Post(':id/reassign')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async reassign(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await reassignApprover(this.db, req.auth.accountId, id);
    } catch (e) {
      if (e instanceof VacationError) mapReassign(e);
      throw e;
    }
  }

  @Post(':id/annul')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async annul(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = z.object({ reason: z.string().max(500) }).safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    try {
      await annulApproved(this.db, req.auth.accountId, id, dto.data.reason);
    } catch (e) {
      if (e instanceof VacationError) mapAnnul(e);
      throw e;
    }
  }
}

function mapAnnul(e: VacationError): never {
  if (e.code === 'NOT_FOUND') throw new NotFoundException();
  if (e.code === 'REASON_REQUIRED') throw new BadRequestException({ code: e.code });
  // ya anulada, no aprobada, ya terminó o un período que no se encuentra: el estado impide anular
  throw new ConflictException({ code: e.code });
}

function mapReassign(e: VacationError): never {
  if (e.code === 'NOT_FOUND') throw new NotFoundException();
  // el área no tiene hoy un único aprobador vigente: hay que designarlo antes
  if (e.code === 'NO_MANAGER') throw new UnprocessableEntityException({ code: e.code });
  // no está pendiente del primer visto bueno o ya la tiene quien corresponde
  throw new ConflictException({ code: e.code });
}
