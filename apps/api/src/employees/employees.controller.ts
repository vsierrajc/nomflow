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
import {
  EmployeeError,
  createEmployee,
  employeeHistory,
  getEmployee,
  listEmployees,
  setEmployeeStatus,
  updateEmployee,
} from './employees.service';

const text = (max: number) => z.string().trim().max(max);
const opt = (max: number) => text(max).nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Reason = z.string().trim().min(10).max(500);

const Common = {
  cEmp: text(30).min(1),
  nombre: text(200).min(1),
  nombres: opt(200),
  apellidos: opt(200),
  email: text(254).min(3),
  est: z.enum(['V', 'C']),
  cArea: text(30).min(1),
  cCos: opt(30),
  cCar: opt(30),
  tipoContrato: text(30).min(1),
  fIni: date,
  fecNac: date.nullable().optional(),
  sAct: opt(20),
  hliq: opt(30),
  sexo: opt(20),
  turno: opt(30),
  celular: opt(30),
  profesion: opt(200),
  nivelEducativo: opt(100),
};

const CreateDto = z.object({
  nIde: text(30).min(3),
  nCont: text(30).min(1),
  ...Common,
  reason: Reason,
});
const UpdateDto = z.object({ ...Common, version: z.number().int().positive(), reason: Reason });
const StatusDto = z.object({
  est: z.enum(['V', 'C']),
  version: z.number().int().positive(),
  reason: Reason,
});
const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  est: z.enum(['V', 'C']).optional(),
  cEmp: z.string().trim().max(30).optional(),
  cArea: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function map(e: unknown): never {
  if (!(e instanceof EmployeeError)) throw e;
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'INVALID':
      throw new UnprocessableEntityException({ code: e.code, issues: e.issues });
    default:
      throw new ConflictException({ code: e.code });
  }
}

@Controller('admin/employees')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class EmployeesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: unknown) {
    const q = ListQuery.safeParse(query);
    if (!q.success) throw new BadRequestException();
    return listEmployees(this.db, q.data);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      return await getEmployee(this.db, req.auth.accountId, id);
    } catch (e) {
      return map(e);
    }
  }

  @Get(':id/history')
  @Header('Cache-Control', 'no-store')
  async history(@Param('id', ParseUUIDPipe) id: string) {
    try {
      return await employeeHistory(this.db, id);
    } catch (e) {
      return map(e);
    }
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    const { reason, ...input } = dto.data;
    try {
      return await createEmployee(this.db, req.auth.accountId, input, reason);
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
    const { reason, ...input } = dto.data;
    try {
      return await updateEmployee(this.db, req.auth.accountId, id, input, reason);
    } catch (e) {
      return map(e);
    }
  }

  @Post(':id/status')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async status(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = StatusDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await setEmployeeStatus(
        this.db,
        req.auth.accountId,
        id,
        dto.data.est,
        dto.data.version,
        dto.data.reason,
      );
    } catch (e) {
      return map(e);
    }
  }
}
