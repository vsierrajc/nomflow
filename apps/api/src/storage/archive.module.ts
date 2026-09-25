import { Module } from '@nestjs/common';
import { AdminArchiveController } from './archive.controller';
import { ArchiveMonitor } from './archive-monitor';
import { ArchiveService } from './archive.service';

@Module({
  controllers: [AdminArchiveController],
  providers: [ArchiveService, ArchiveMonitor],
  exports: [ArchiveService],
})
export class ArchiveModule {}
