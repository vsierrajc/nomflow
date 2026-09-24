import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
  StreamableFile,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  MAX_SUPPORT_BYTES,
  PermitError,
  cancelPermit,
  createType,
  detail,
  getSupport,
  listAssignedToManager,
  listMine,
  listTypes,
  managerApprove,
  managerReject,
  submitPermit,
  updateType,
} from './permit.service';

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TypeDto = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).nullish(),
  supportRequired: z.boolean(),
  allowsHours: z.boolean(),
  maxDays: z.number().int().min(1).max(365).nullish(),
  active: z.boolean(),
});
const CreateTypeDto = TypeDto.extend({ code: z.string().trim().min(1).max(30) });
const UpdateTypeDto = TypeDto.extend({ version: z.number().int().positive() });
const ReasonDto = z.object({ reason: z.string().trim().min(10).max(500) });

const opt = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const SubmitDto = z.object({
  typeId: z.string().uuid(),
  start: iso,
  end: iso,
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  justification: z.string().max(2000),
});

/** Traduce los errores del flujo de permisos a respuestas HTTP sin exponer detalles internos. */
function map(e: unknown): never {
  if (!(e instanceof PermitError)) throw e;
  switch (e.code) {
    case 'NOT_FOUND':
      throw new NotFoundException();
    case 'FORBIDDEN':
    case 'SELF_APPROVAL':
      throw new ForbiddenException({ code: e.code });
    case 'NO_MANAGER':
    case 'NO_ACTIVE_CONTRACT':
      throw new UnprocessableEntityException({ code: e.code });
    case 'INVALID_STATE':
    case 'OVERLAP':
    case 'EXISTS':
    case 'VERSION_CONFLICT':
      throw new ConflictException({ code: e.code });
    default:
      throw new BadRequestException({ code: e.code });
  }
}

/** Catálogo de tipos de permiso: solo administradores. */
@Controller('admin/permit-types')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminPermitTypesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return listTypes(this.db, false);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = CreateTypeDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await createType(this.db, req.auth.accountId, dto.data);
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
    const dto = UpdateTypeDto.safeParse(body);
    if (!dto.success) throw new BadRequestException();
    try {
      return await updateType(this.db, req.auth.accountId, id, dto.data);
    } catch (e) {
      return map(e);
    }
  }
}

@Controller('me/permits')
@UseGuards(SessionGuard)
export class MePermitsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('types')
  @Header('Cache-Control', 'no-store')
  async types() {
    return (await listTypes(this.db, true)).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      supportRequired: t.supportRequired,
      allowsHours: t.allowsHours,
      maxDays: t.maxDays,
    }));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(RecentAuthGuard)
  @UseInterceptors(
    FileInterceptor('support', { limits: { fileSize: MAX_SUPPORT_BYTES, files: 1 } }),
  )
  async submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
  ) {
    const dto = SubmitDto.safeParse({
      ...body,
      startTime: opt(body.startTime),
      endTime: opt(body.endTime),
    });
    if (!dto.success) throw new BadRequestException();
    try {
      return await submitPermit(this.db, req.auth.accountId, {
        ...dto.data,
        support: file ? { buffer: file.buffer, fileName: file.originalname } : undefined,
      });
    } catch (e) {
      return map(e);
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
      return map(e);
    }
  }

  @Get(':id/support')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async support(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      const s = await getSupport(this.db, req.auth.accountId, id);
      return new StreamableFile(s.data, {
        type: s.contentType,
        disposition: `attachment; filename="${s.fileName}"`,
      });
    } catch (e) {
      return map(e);
    }
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    try {
      await cancelPermit(this.db, req.auth.accountId, id);
      return { ok: true };
    } catch (e) {
      return map(e);
    }
  }
}

/** Bandeja del jefe de área: solo los permisos de las personas cuya área le fue asignada. */
@Controller('approvals/permits/manager')
@UseGuards(SessionGuard, RolesGuard)
@Roles('AREA_MANAGER')
export class ManagerPermitsController {
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
      return map(e);
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
      return map(e);
    }
  }
}
