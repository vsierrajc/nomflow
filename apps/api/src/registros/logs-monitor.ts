import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { LogsService } from './logs.service';

const HOUR = 3_600_000;

/** Mantenimiento diario de registros según la política (archivar y depurar), si está activado. */
@Injectable()
export class LogsMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('LogsMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(@Inject(LogsService) private readonly logs: LogsService) {}

  private enabled(): boolean {
    return (
      process.env.LOGS_SCHEDULER !== 'off' && process.env.NODE_ENV !== 'test' && !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (this.enabled()) this.schedule(Number(process.env.LOGS_START_DELAY_MS ?? 180_000));
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
      const s = await this.logs.getSettings();
      const last = s.lastRunAt ? s.lastRunAt.getTime() : 0;
      if (s.autoEnabled && Date.now() - last > 20 * HOUR) {
        try {
          const r = await this.logs.runMaintenance(null);
          await this.logs.recordRun('OK', `Archivados ${r.archived}, depurados ${r.purged}.`);
        } catch (e) {
          await this.logs.recordRun('ERROR', (e as Error).message);
          throw e;
        }
      }
    } catch (e) {
      this.log.error(`Falló el mantenimiento de registros: ${(e as Error).message}`);
    }
    this.schedule(HOUR);
  }
}
