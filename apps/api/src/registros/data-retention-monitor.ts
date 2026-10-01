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
      const s = await this.retention.getSettings();
      const last = s.lastRunAt ? s.lastRunAt.getTime() : 0;
      if (s.autoEnabled && Date.now() - last > 20 * HOUR) {
        try {
          const r = await this.retention.runMaintenance(null);
          await this.retention.recordRun(
            'OK',
            `Sesiones ${r.sessions}, códigos ${r.verificationCodes}, filas de importación ${r.importRows}, ZIP ${r.exports}.`,
          );
        } catch (e) {
          await this.retention.recordRun('ERROR', (e as Error).message);
          throw e;
        }
      }
    } catch (e) {
      this.log.error(`Falló la depuración de datos operativos: ${(e as Error).message}`);
    }
    this.schedule(HOUR);
  }
}
