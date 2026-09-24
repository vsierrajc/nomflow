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
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { CATALOGS, isCatalogKind, type CatalogKind } from './catalog.parser';
import {
  EntryError,
  createEntry,
  entryHistory,
  listEntries,
  updateEntry,
} from './catalog-entries.service';

const ListQuery = z.object({
  cEmp: z.string().trim().max(30).optional(),
  q: z.string().trim().max(100).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const CreateDto = z.object({
  cEmp: z.string().trim().min(1).max(30).optional(),
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
});
const UpdateDto = z.object({
  name: z.string().trim().min(1).max(200),
  active: z.boolean(),
  version: z.number().int().positive(),
});

function kindOf(raw: string): CatalogKind {
  if (!isCatalogKind(raw)) throw new NotFoundException();
  return raw;
}

function map(e: unknown): never {
  if (!(e instanceof EntryError)) throw e;
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'EXISTS':
    case 'VERSION_CONFLICT':
      throw new ConflictException({ code: e.code });
    case 'IN_USE':
      throw new ConflictException({ code: e.code, usage: e.detail });
    default:
      throw new UnprocessableEntityException({ code: e.code });
  }
}

@Controller('admin/catalogs')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class CatalogsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  kinds() {
    return (Object.keys(CATALOGS) as CatalogKind[]).map((kind) => ({
      kind,
      global: CATALOGS[kind].global,
    }));
  }

  @Get(':kind')
  @Header('Cache-Control', 'no-store')
  list(@Param('kind') kind: string, @Query() query: unknown) {
    const k = kindOf(kind);
    const q = ListQuery.safeParse(query);
    if (!q.success || (!CATALOGS[k].global && !q.data.cEmp)) throw new BadRequestException();
    return listEntries(this.db, k, q.data);
  }

  @Post(':kind')
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Param('kind') kind: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const k = kindOf(kind);
    const dto = CreateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createEntry(this.db, req.auth.accountId, k, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Put(':kind/:id')
  @UseGuards(RecentAuthGuard)
  async update(
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const k = kindOf(kind);
    const dto = UpdateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await updateEntry(this.db, req.auth.accountId, k, id, dto.data);
    } catch (e) {
      return map(e);
    }
  }

  @Get(':kind/:id/history')
  @Header('Cache-Control', 'no-store')
  async history(@Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string) {
    const k = kindOf(kind);
    try {
      return await entryHistory(this.db, k, id);
    } catch (e) {
      return map(e);
    }
  }
}
