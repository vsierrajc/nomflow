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
import { ShiftError, createShift, listShifts, updateShift } from './shifts.service';

const ShiftDto = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).nullish(),
  monday: z.boolean(),
  tuesday: z.boolean(),
  wednesday: z.boolean(),
  thursday: z.boolean(),
  friday: z.boolean(),
  saturday: z.boolean(),
  sunday: z.boolean(),
  active: z.boolean(),
});
const CreateShiftDto = ShiftDto.extend({ code: z.string().trim().min(1).max(30) });
const UpdateShiftDto = ShiftDto.extend({ version: z.number().int().positive() });

function map(e: unknown): never {
  if (!(e instanceof ShiftError)) throw e;
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'INVALID_SHIFT':
      throw new UnprocessableEntityException({ code: e.code });
    default:
      throw new ConflictException({ code: e.code });
  }
}

/** Catálogo de turnos: qué días de la semana son laborales para vacaciones. Solo administradores. */
@Controller('admin/shifts')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminShiftsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return listShifts(this.db, false);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateShiftDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createShift(this.db, req.auth.accountId, dto.data);
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
    const dto = UpdateShiftDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await updateShift(this.db, req.auth.accountId, id, dto.data);
    } catch (e) {
      return map(e);
    }
  }
}
