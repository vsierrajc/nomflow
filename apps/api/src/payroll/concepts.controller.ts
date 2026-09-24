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
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { ConceptError, createConcept, listConcepts, updateConcept } from './concepts.service';
import { knownUnits } from './units';

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  unit: z.string().trim().max(10).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const CreateDto = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(10),
});
const UpdateDto = z.object({
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(10),
  active: z.boolean(),
  version: z.number().int().positive(),
});

function map(e: unknown): never {
  if (!(e instanceof ConceptError)) throw e;
  switch (e.code) {
    case 'EXISTS':
    case 'VERSION_CONFLICT':
      throw new ConflictException({ code: e.code });
    case 'NOT_FOUND':
      throw new NotFoundException();
    default:
      throw new BadRequestException({ code: e.code });
  }
}

@Controller('admin/payroll-concepts')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class ConceptsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown) {
    const q = ListQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    return listConcepts(this.db, q.data);
  }

  @Get('units')
  units() {
    return knownUnits();
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createConcept(this.db, req.auth.accountId, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Put(':id')
  @UseGuards(RecentAuthGuard)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = UpdateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await updateConcept(this.db, req.auth.accountId, id, dto.data);
    } catch (e) {
      return map(e);
    }
  }
}
