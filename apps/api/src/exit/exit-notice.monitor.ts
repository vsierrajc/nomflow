import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ExitNoticeService } from './exit-notice.service';

/** Revisa periódicamente qué bajas programadas ya entraron en el plazo de aviso. Sin cola de trabajos. */
@Injectable()
export class ExitNoticeMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ExitNoticeMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(@Inject(ExitNoticeService) private readonly service: ExitNoticeService) {}

  private enabled(): boolean {
    return (
      process.env.EXIT_MONITOR !== 'off' && process.env.NODE_ENV !== 'test' && !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.schedule(Number(process.env.EXIT_MONITOR_START_DELAY_MS ?? 30_000));
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
      await this.service.runOnce();
    } catch (e) {
      this.log.error(`Falló la revisión de bajas programadas: ${(e as Error).message}`);
    }
    this.schedule(Number(process.env.EXIT_MONITOR_INTERVAL_MS ?? 3_600_000));
  }
}
