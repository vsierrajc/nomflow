import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ExitController } from './exit.controller';
import { ExitNoticeMonitor } from './exit-notice.monitor';
import { ExitNoticeService } from './exit-notice.service';
import { ExportZipMonitor } from './export-zip.monitor';
import { MyExitController } from './my-exit.controller';

@Module({
  imports: [StorageModule],
  controllers: [ExitController, MyExitController],
  providers: [ExitNoticeService, ExitNoticeMonitor, ExportZipMonitor],
})
export class ExitModule {}
