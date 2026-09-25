import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
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
import { ArchiveSettingsError } from './archive-settings.service';
import { ArchiveError, ArchiveService } from './archive.service';

const SettingsDto = z.object({
  enabled: z.boolean(),
  endpoint: z.string().trim().min(8).max(300),
  region: z.string().trim().min(2).max(40),
  bucket: z.string().trim().min(3).max(222),
  accessKeyId: z.string().max(200).nullish(),
  secret: z.string().max(500).optional(),
  ageDays: z.number().int(),
  graceDays: z.number().int(),
});

/** Archivo histórico en la nube: solo administradores. La clave se guarda cifrada y no se devuelve. */
@Controller('admin/archive')
@UseGuards(SessionGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
export class AdminArchiveController {
  constructor(@Inject(ArchiveService) private readonly archive: ArchiveService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  overview() {
    return this.archive.overview();
  }

  @Put('settings')
  @UseGuards(RecentAuthGuard)
  async save(@Body() body: unknown, @Req() req: AuthedRequest) {
    const dto = SettingsDto.safeParse(body);
    if (!dto.success) throw new BadRequestException({ code: 'INVALID_SETTINGS' });
    try {
      return await this.archive.save(req.auth.accountId, dto.data);
    } catch (e) {
      if (e instanceof ArchiveSettingsError) throw new BadRequestException({ code: e.code });
      throw e;
    }
  }

  @Post('test')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async test() {
    const code = await this.archive.test();
    if (code === 'NOT_CONFIGURED') throw new BadRequestException({ code });
    if (code !== 'OK') throw new BadGatewayException({ code });
    return { ok: true };
  }

  @Post('run')
  @HttpCode(200)
  @UseGuards(RecentAuthGuard)
  async run(@Req() req: AuthedRequest) {
    try {
      const result = await this.archive.run(req.auth.accountId);
      return { ...result, overview: await this.archive.overview() };
    } catch (e) {
      if (e instanceof ArchiveError) {
        if (e.code === 'BUSY') throw new ConflictException({ code: e.code });
        throw new BadRequestException({ code: e.code });
      }
      throw e;
    }
  }
}
