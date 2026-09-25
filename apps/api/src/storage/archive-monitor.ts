import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { getArchiveSettings } from './archive-settings.service';
import { ArchiveService } from './archive.service';

const HOUR = 3_600_000;

/** Archivado diario: cada hora revisa si toca (habilitado y sin ejecución en las últimas 20 horas). */
@Injectable()
export class ArchiveMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ArchiveMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ArchiveService) private readonly archive: ArchiveService,
  ) {}

  private enabled(): boolean {
    return (
      process.env.ARCHIVE_SCHEDULER !== 'off' &&
      process.env.NODE_ENV !== 'test' &&
      !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (this.enabled()) this.schedule(Number(process.env.ARCHIVE_START_DELAY_MS ?? 120_000));
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const s = await getArchiveSettings(this.db);
      const last = s.lastRunAt ? s.lastRunAt.getTime() : 0;
      if (s.enabled && Date.now() - last > 20 * HOUR) await this.archive.run(null);
    } catch (e) {
      this.log.error(`Falló el archivado programado: ${(e as Error).message}`);
    }
    this.schedule(HOUR);
  }
}
