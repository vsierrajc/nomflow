import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  ForbiddenException,
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
import {
  HolidayError,
  calendarDays,
  createDraft,
  listCalendars,
  publish,
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
import { HolidayApiError, getSettings, saveSettings, syncYear } from './holiday-api.service';
import { PlanError, type Allocation } from './leave-plan';
import { planLeave } from './leave-plan';
import {
  VacationError,
  acceptRevision,
  cancelRequest,
  detail,
  finalApprove,
  finalReject,
  listAssignedToManager,
  listForFinal,
  listMine,
  managerApprove,
  managerPropose,
  managerReject,
  submitRequest,
} from './vacation.service';

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

const SettingsDto = z.object({
  url: z.string().trim().min(1).max(300),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
});

/** Configuración del servicio externo de festivos: la clave se guarda cifrada y nunca se devuelve. */
@Controller('admin/holiday-api')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminHolidayApiController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  settings() {
    return getSettings(this.db);
  }

  @Put()
  @UseGuards(RecentAuthGuard)
  async save(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = SettingsDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      await saveSettings(this.db, req.auth.accountId, dto.data);
      return await getSettings(this.db);
    } catch (e) {
      return mapApi(e);
    }
  }

  @Post('sync')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async sync(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z.object({ year: z.number().int() }).safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await syncYear(this.db, req.auth.accountId, dto.data.year);
    } catch (e) {
      return mapApi(e);
    }
  }
}

function mapApi(e: unknown): never {
  if (!(e instanceof HolidayApiError)) throw e;
  switch (e.code) {
    case 'INVALID_URL':
    case 'INVALID_YEAR':
    case 'NOT_CONFIGURED':
    case 'NO_API_KEY':
      throw new BadRequestException({ code: e.code });
    default:
      // El servicio externo falló: se conserva la última versión local publicada.
      throw new BadGatewayException({ code: e.code });
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

const AllocationsDto = z
  .array(z.object({ progVacId: z.string().uuid(), days: z.number().int().min(1) }))
  .min(1)
  .max(10);
const PreviewDto = z.object({ start: iso, allocations: AllocationsDto });
const ProposeDto = PreviewDto.extend({ reason: z.string().trim().min(10).max(500) });
const ReasonDto = z.object({ reason: z.string().trim().min(10).max(500) });

/** Traduce los errores del flujo a respuestas HTTP sin exponer detalles internos. */
function mapLeave(e: unknown): never {
  if (e instanceof PlanError) {
    if (e.code === 'CALENDAR_MISSING')
      throw new UnprocessableEntityException({ code: 'HOLIDAY_CALENDAR_MISSING', years: e.years });
    if (e.code === 'NOT_FOUND') throw new NotFoundException();
    throw new BadRequestException({ code: e.code });
  }
  if (e instanceof VacationError) {
    switch (e.code) {
      case 'NOT_FOUND':
        throw new NotFoundException();
      case 'FORBIDDEN':
      case 'SELF_APPROVAL':
        throw new ForbiddenException({ code: e.code });
      case 'NO_MANAGER':
      case 'NO_ACTIVE_CONTRACT':
        throw new UnprocessableEntityException({ code: e.code });
      case 'REASON_REQUIRED':
        throw new BadRequestException({ code: e.code });
      default:
        throw new ConflictException({ code: e.code });
    }
  }
  throw e;
}

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
    try {
      return await planLeave(this.db, contract, dto.data.start, dto.data.allocations);
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async submit(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = PreviewDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await submitRequest(this.db, req.auth.accountId, dto.data);
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return listMine(this.db, req.auth.accountId);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async one(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      return await detail(this.db, req.auth.accountId, id);
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Post(':id/accept')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async accept(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await acceptRevision(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await cancelRequest(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }
}

/** Bandeja del jefe de área: solo solicitudes que le fueron asignadas y solo con el rol vigente. */
@Controller('approvals/vacations/manager')
@UseGuards(SessionGuard, RolesGuard)
@Roles('AREA_MANAGER')
export class ManagerVacationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return listAssignedToManager(this.db, req.auth.accountId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await managerApprove(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Post(':id/reject')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = ReasonDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    try {
      await managerReject(this.db, req.auth.accountId, id, dto.data.reason);
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Post(':id/propose')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async propose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = ProposeDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const allocations: Allocation[] = dto.data.allocations;
    try {
      await managerPropose(this.db, req.auth.accountId, id, { ...dto.data, allocations });
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }
}

/** Bandeja de la aprobación final: exige el rol VACATION_FINAL_APPROVER vigente. */
@Controller('approvals/vacations/final')
@UseGuards(SessionGuard, RolesGuard)
@Roles('VACATION_FINAL_APPROVER')
export class FinalVacationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    void req;
    return listForFinal(this.db);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await finalApprove(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }

  @Post(':id/reject')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = ReasonDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'REASON_REQUIRED' });
    try {
      await finalReject(this.db, req.auth.accountId, id, dto.data.reason);
      return { ok: true };
    } catch (e) {
      return mapLeave(e);
    }
  }
}
