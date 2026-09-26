import { Module } from '@nestjs/common';
import { AdminLogsController } from './logs.controller';
import { LogsMonitor } from './logs-monitor';
import { LogsService } from './logs.service';

@Module({
  controllers: [AdminLogsController],
  providers: [LogsService, LogsMonitor],
  exports: [LogsService],
})
export class LogsModule {}
