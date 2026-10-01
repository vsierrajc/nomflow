import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { RecentAuthGuard, Roles, RolesGuard } from '../auth/guards';
import { ADMIN_ROLES } from '../auth/roles';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import { DataRetentionError, DataRetentionService } from './data-retention.service';

const SettingsDto = z.object({
  sessionsRetentionDays: z.number().int(),
  verificationCodesRetentionDays: z.number().int(),
  importStagingRetentionDays: z.number().int(),
  autoEnabled: z.boolean(),
});

/** Política de retención de datos operativos (sesiones, códigos, importaciones, ZIP de baja). */
@Controller('admin/data-retention')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminDataRetentionController {
  constructor(@Inject(DataRetentionService) private readonly retention: DataRetentionService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async summary() {
    const [settings, preview, history] = await Promise.all([
      this.retention.getSettings(),
      this.retention.preview(),
      this.retention.history(),
    ]);
    return { settings, preview, history };
  }

  @Put('settings')
  @UseGuards(RecentAuthGuard)
  async settings(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = SettingsDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID' });
    try {
      return await this.retention.saveSettings(req.auth.accountId, dto.data);
    } catch (e) {
      if (e instanceof DataRetentionError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }

  @Post('run')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  run(@Req() req: AuthedRequest) {
    return this.retention.runAndRecord(req.auth.accountId);
  }

  /** Estado de los certificados de retención de una persona (solo lectura). */
  @Get('certificates/:nIde')
  @Header('Cache-Control', 'no-store')
  certificates(@Param('nIde') nIde: string) {
    return this.retention.certificatesStatus(nIde);
  }

  /** Borrado manual de los certificados de un empleado dado de baja; exige confirmar el número de identificación. */
  @Delete('certificates/:nIde')
  @UseGuards(RecentAuthGuard)
  async deleteCertificates(
    @Param('nIde') nIde: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    const dto = z.object({ confirmNIde: z.string() }).safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID' });
    try {
      return await this.retention.deleteCertificates(
        req.auth.accountId,
        nIde,
        dto.data.confirmNIde,
      );
    } catch (e) {
      if (e instanceof DataRetentionError) {
        if (e.code === 'NOT_FOUND') throw new NotFoundException({ code: e.code });
        throw new BadRequestException({ code: e.code });
      }
      throw e;
    }
  }
}
