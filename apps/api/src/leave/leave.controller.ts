import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { LeaveCalcError, computeLeave, yearsNeeded } from './business-days';
import {
  HolidayError,
  calendarDays,
  createDraft,
  listCalendars,
  publish,
  publishedHolidays,
} from './holidays.service';
import {
  ProgVacError,
  activeContract,
  adjustPeriod,
  createPeriod,
  deactivatePeriod,
  listAdjustments,
  listPeriods,
  myOpenPeriods,
} from './prog-vac.service';
import { progVac } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DraftDto = z.object({
  year: z.number().int(),
  source: z.enum(['MANUAL', 'EXCEL']).default('MANUAL'),
  reason: z.string().trim().min(10).max(300),
  days: z.array(z.object({ date: iso, name: z.string().trim().min(1).max(100) })).max(40),
});
const PeriodDto = z.object({
  nIde: z.string().trim().min(1).max(30),
  nCont: z.string().trim().min(1).max(30),
  perIni: iso,
  perFin: iso,
  dias: z.number().int(),
  disp: z.number().int(),
  estOrigen: z.string().trim().max(30).nullish(),
  fechaCorte: iso.nullish(),
});
const AdjustDto = z.object({
  dias: z.number().int(),
  disp: z.number().int(),
  reason: z.string().trim().min(10).max(300),
});

function mapProgVac(e: unknown): never {
  if (e instanceof ProgVacError) {
    if (e.code === 'NOT_FOUND') throw new NotFoundException();
    if (e.code === 'DUPLICATE') throw new ConflictException({ code: e.code });
    throw new BadRequestException({ code: e.code });
  }
  throw e;
}

@Controller('admin/holidays')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminHolidaysController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query('year') year: string | undefined) {
    return listCalendars(this.db, year && /^\d{4}$/.test(year) ? Number(year) : undefined);
  }

  @Get(':id/days')
  @Header('Cache-Control', 'no-store')
  async days(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await calendarDays(this.db, id);
    } catch (e) {
      if (e instanceof HolidayError) throw new NotFoundException();
      throw e;
    }
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async draft(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = DraftDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createDraft(
        this.db,
        req.auth.accountId,
        dto.data.year,
        dto.data.days,
        dto.data.source,
        dto.data.reason,
      );
    } catch (e) {
      if (e instanceof HolidayError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }

  @Post(':id/publish')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async publish(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await publish(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      if (e instanceof HolidayError) {
        if (e.code === 'NOT_FOUND') throw new NotFoundException();
        throw new ConflictException({ code: e.code });
      }
      throw e;
    }
  }
}

@Controller('admin/prog-vac')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminProgVacController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query('nIde') nIde: string | undefined) {
    return listPeriods(this.db, nIde?.trim() || undefined);
  }

  @Get(':id/adjustments')
  @Header('Cache-Control', 'no-store')
  adjustments(@Param('id', ParseUUIDPipe) id: string) {
    return listAdjustments(this.db, id);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = PeriodDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createPeriod(this.db, req.auth.accountId, dto.data);
    } catch (e) {
      return mapProgVac(e);
    }
  }

  @Put(':id')
  @UseGuards(RecentAuthGuard)
  async adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = AdjustDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await adjustPeriod(this.db, req.auth.accountId, id, dto.data);
      return { ok: true };
    } catch (e) {
      return mapProgVac(e);
    }
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(RecentAuthGuard)
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await deactivatePeriod(this.db, req.auth.accountId, id);
    } catch (e) {
      mapProgVac(e);
    }
  }
}

const PreviewDto = z.object({
  start: iso,
  allocations: z
    .array(z.object({ progVacId: z.string().uuid(), days: z.number().int().min(1) }))
    .min(1)
    .max(10),
});

@Controller('me/vacations')
@UseGuards(SessionGuard)
export class MeVacationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('periods')
  @Header('Cache-Control', 'no-store')
  periods(@Req() req: AuthedRequest) {
    return myOpenPeriods(this.db, req.auth.accountId);
  }

  /** Calcula fechas sin crear nada: valida períodos propios, remanentes y calendario publicado. */
  @Post('preview')
  @HttpCode(200)
  async preview(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = PreviewDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const contract = await activeContract(this.db, req.auth.accountId);
    if (!contract) throw new NotFoundException();
    const ids = dto.data.allocations.map((a) => a.progVacId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException({ code: 'DUPLICATE' });
    const rows = await this.db
      .select()
      .from(progVac)
      .where(
        and(
          inArray(progVac.id, ids),
          eq(progVac.nIde, contract.nIde),
          eq(progVac.nCont, contract.nCont),
          eq(progVac.active, true),
        ),
      );
    if (rows.length !== ids.length) throw new NotFoundException();
    for (const a of dto.data.allocations) {
      const r = rows.find((x) => x.id === a.progVacId);
      if (!r || a.days > r.disp) throw new BadRequestException({ code: 'EXCEEDS_DISP' });
    }
    const total = dto.data.allocations.reduce((s, a) => s + a.days, 0);
    const years = yearsNeeded(dto.data.start, total);
    const cal = await publishedHolidays(this.db, years);
    if (cal.missingYears.length > 0)
      throw new UnprocessableEntityException({
        code: 'HOLIDAY_CALENDAR_MISSING',
        years: cal.missingYears,
      });
    try {
      return { ...computeLeave(dto.data.start, total, cal.set), calendarIds: cal.calendarIds };
    } catch (e) {
      if (e instanceof LeaveCalcError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }
}
