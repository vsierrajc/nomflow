import { Module } from '@nestjs/common';
import { AdminAccountsController } from './accounts/admin-accounts.controller';
import { AuthController } from './auth/auth.controller';
import { RecentAuthGuard, RolesGuard } from './auth/guards';
import { SessionGuard } from './auth/session.guard';
import { DbModule } from './db/db.module';
import { ImportsController } from './imports/imports.controller';
import { MailModule } from './mail/mail.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule, MailModule],
  controllers: [HealthController, AuthController, AdminAccountsController, ImportsController],
  providers: [SessionGuard, RolesGuard, RecentAuthGuard],
})
export class AppModule {}
