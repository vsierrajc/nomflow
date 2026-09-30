import { Module } from '@nestjs/common';
import { AdminDataRetentionController } from './data-retention.controller';
import { DataRetentionMonitor } from './data-retention-monitor';
import { DataRetentionService } from './data-retention.service';
import { AdminLogsController } from './logs.controller';
import { LogsMonitor } from './logs-monitor';
import { LogsService } from './logs.service';

@Module({
  controllers: [AdminLogsController, AdminDataRetentionController],
  providers: [LogsService, LogsMonitor, DataRetentionService, DataRetentionMonitor],
  exports: [LogsService, DataRetentionService],
})
export class LogsModule {}
