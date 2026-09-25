import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import { NotificationService, NotificationSettingsError } from './notification.service';

const Dto = z.object({
  notifyApprover: z.boolean(),
  notifyEmployee: z.boolean(),
  reminderDays: z.number().int(),
  appUrl: z.string().max(200),
});

/** Avisos por correo del flujo: solo administradores. */
@Controller('admin/notifications')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminNotificationsController {
  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async overview() {
    return {
      settings: await this.notifications.getSettings(),
      recent: await this.notifications.history(50),
    };
  }

  @Put('settings')
  @UseGuards(RecentAuthGuard)
  async save(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = Dto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SETTINGS' });
    try {
      return await this.notifications.saveSettings(req.auth.accountId, dto.data);
    } catch (e) {
      if (e instanceof NotificationSettingsError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }
}
