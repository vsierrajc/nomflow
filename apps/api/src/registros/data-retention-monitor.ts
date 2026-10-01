import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DataRetentionService } from './data-retention.service';

const HOUR = 3_600_000;

/** Depuración diaria de datos operativos según la política, si está activada. */
@Injectable()
export class DataRetentionMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DataRetentionMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(@Inject(DataRetentionService) private readonly retention: DataRetentionService) {}

  private enabled(): boolean {
    return (
      process.env.DATA_RETENTION_SCHEDULER !== 'off' &&
      process.env.NODE_ENV !== 'test' &&
      !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (this.enabled()) this.schedule(Number(process.env.DATA_RETENTION_START_DELAY_MS ?? 180_000));
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
      await this.retention.runIfDue();
    } catch (e) {
      this.log.error(`Falló la depuración de datos operativos: ${(e as Error).message}`);
    }
    this.schedule(HOUR);
  }
}
