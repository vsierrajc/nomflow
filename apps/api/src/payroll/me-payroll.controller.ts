import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { VoucherError, downloadVoucher, listMyVouchers } from './voucher.service';

const Params = z.object({
  per: z.string().regex(/^\d{6}$/),
  nLiq: z.enum(['1', '2']).transform(Number),
  contrato: z.string().min(1).max(40),
});

@Controller('me/payroll')
@UseGuards(SessionGuard)
export class MePayrollController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return listMyVouchers(this.db, req.auth.accountId);
  }

  @Get(':per/:nLiq/:contrato/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async pdf(
    @Param() raw: unknown,
    @Query('mode') mode: string | undefined,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    const params = Params.safeParse(raw);
    if (!params.success) throw new BadRequestException();
    try {
      const { pdf, fileName } = await downloadVoucher(
        this.db,
        req.auth.accountId,
        params.data,
        mode,
      );
      return new StreamableFile(pdf, {
        type: 'application/pdf',
        disposition: `attachment; filename="${fileName}"`,
      });
    } catch (e) {
      if (e instanceof VoucherError) {
        if (e.code === 'INVALID_MODE') throw new BadRequestException({ code: e.code });
        throw new NotFoundException();
      }
      throw e;
    }
  }
}
