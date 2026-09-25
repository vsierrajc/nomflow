import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
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
import { HealthService, HealthSettingsError } from './health.service';

const int = z.number().int();
const SettingsDto = z.object({
  storageWarnFreePct: int,
  storageCritFreePct: int,
  dbWarnMs: int,
  dbCritMs: int,
  objectErrorsWarn: int,
  objectErrorsCrit: int,
  errorWindowMin: int,
  checkIntervalMin: int,
  renotifyMin: int,
  extraRecipients: z.string().max(2000),
});

/** Salud del sistema: solo administradores. */
@Controller('admin/health')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminHealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async status() {
    const snap = await this.health.latest();
    return { ...snap, settings: await this.health.getSettings() };
  }

  @Post('check')
  @HttpCode(200)
  async checkNow() {
    return this.health.check();
  }

  @Get('alerts')
  @Header('Cache-Control', 'no-store')
  async alerts(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return { alerts: await this.health.history(n) };
  }

  @Put('settings')
  @UseGuards(RecentAuthGuard)
  async save(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = SettingsDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SETTINGS' });
    try {
      return await this.health.saveSettings(req.auth.accountId, dto.data);
    } catch (e) {
      if (e instanceof HealthSettingsError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }
}
