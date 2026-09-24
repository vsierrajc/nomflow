import { Global, Module } from '@nestjs/common';
import { DB } from '../db/db.module';
import { DbModule } from '../db/db.module';
import type { Db } from '../db/client';
import { ConfigurableMailer, MAILER } from './mailer';

@Global()
@Module({
  imports: [DbModule],
  providers: [
    { provide: MAILER, useFactory: (db: Db) => new ConfigurableMailer(db), inject: [DB] },
  ],
  exports: [MAILER],
})
export class MailModule {}
