import { Controller, Get, Header, Inject, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { inboxCount, inboxFor } from './inbox.service';

/** Bandeja de entrada: cada usuario ve solo sus propias actividades y solicitudes. */
@Controller('me/inbox')
@UseGuards(SessionGuard)
export class InboxController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  inbox(@Req() req: AuthedRequest) {
    return inboxFor(this.db, req.auth.accountId);
  }

  @Get('count')
  @Header('Cache-Control', 'no-store')
  async count(@Req() req: AuthedRequest) {
    return { pending: await inboxCount(this.db, req.auth.accountId) };
  }
}
