import { Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { SessionGuard } from './auth/session.guard';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule],
  controllers: [HealthController, AuthController],
  providers: [SessionGuard],
})
export class AppModule {}
