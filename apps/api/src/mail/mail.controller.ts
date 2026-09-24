import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { MailSettingsError, getSettings, saveSettings, sendTest } from './mail-settings.service';

const SettingsDto = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  requireTls: z.boolean(),
  username: z.string().max(200).nullish(),
  password: z.string().max(500).optional(),
  clearPassword: z.boolean().optional(),
  fromEmail: z.string().trim().min(3).max(254),
  fromName: z.string().max(80).nullish(),
});

function map(e: unknown): never {
  if (!(e instanceof MailSettingsError)) throw e;
  if (
    e.code === 'INVALID_SETTINGS' ||
    e.code === 'INVALID_RECIPIENT' ||
    e.code === 'NOT_CONFIGURED'
  )
    throw new BadRequestException({ code: e.code });
  // El servidor de correo falló: se informa el motivo, sin detalles internos.
  throw new BadGatewayException({ code: e.code });
}

/** Configuración del correo saliente: solo administradores. La clave se guarda cifrada y no se devuelve. */
@Controller('admin/mail-settings')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminMailController {
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
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SETTINGS' });
    try {
      await saveSettings(this.db, req.auth.accountId, dto.data);
      return await getSettings(this.db);
    } catch (e) {
      return map(e);
    }
  }

  @Post('test')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async test(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = z.object({ to: z.string().trim().max(254) }).safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_RECIPIENT' });
    try {
      await sendTest(this.db, req.auth.accountId, dto.data.to);
      return { ok: true, settings: await getSettings(this.db) };
    } catch (e) {
      return map(e);
    }
  }
}
