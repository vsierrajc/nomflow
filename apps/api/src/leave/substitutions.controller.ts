import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ForbiddenException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  SubstitutionError,
  adminSubstitutions,
  annulSubstitution,
  createSubstitution,
  endSubstitution,
  mySubstitutions,
  substituteCandidates,
} from './substitutions.service';

function map(e: unknown): never {
  if (e instanceof SubstitutionError) {
    if (e.code === 'NOT_FOUND') throw new NotFoundException({ code: e.code });
    if (e.code === 'NOT_APPROVER') throw new ForbiddenException({ code: e.code });
    if (e.code === 'OVERLAP' || e.code === 'CHAIN' || e.code === 'NOT_ACTIVE')
      throw new UnprocessableEntityException({ code: e.code });
    throw new BadRequestException({ code: e.code });
  }
  throw e;
}

const CreateDto = z.object({
  substituteAccountId: z.string().uuid(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Quien aprueba designa a su suplente y ve las suplencias en que participa. */
@Controller('me/substitutions')
@UseGuards(SessionGuard)
export class MeSubstitutionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return mySubstitutions(this.db, req.auth.accountId);
  }

  @Get('candidates')
  @Header('Cache-Control', 'no-store')
  candidates(@Req() req: AuthedRequest) {
    return substituteCandidates(this.db, req.auth.accountId);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_DATES' });
    try {
      return await createSubstitution(this.db, req.auth.accountId, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Post(':id/end')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async end(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await endSubstitution(this.db, req.auth.accountId, id);
    } catch (e) {
      return map(e);
    }
  }
}

const AdminQuery = z.object({
  status: z.enum(['ACTIVA', 'TERMINADA', 'ANULADA']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Gestión Humana consulta todas las suplencias y puede anularlas. */
@Controller('admin/substitutions')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminSubstitutionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown) {
    const q = AdminQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    return adminSubstitutions(this.db, q.data);
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
      await annulSubstitution(this.db, req.auth.accountId, id, dto.data.reason);
    } catch (e) {
      if (e instanceof SubstitutionError && e.code === 'REASON_REQUIRED')
        throw new BadRequestException({ code: e.code });
      return map(e);
    }
  }
}
