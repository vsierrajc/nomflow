import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HealthService } from './health.service';

/** Verificación periódica: el intervalo lo fija la administración y se relee en cada ciclo. */
@Injectable()
export class HealthMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('HealthMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  private enabled(): boolean {
    return (
      process.env.HEALTH_MONITOR !== 'off' && process.env.NODE_ENV !== 'test' && !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.schedule(Number(process.env.HEALTH_MONITOR_START_DELAY_MS ?? 30_000));
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
    let minutes = 5;
    try {
      minutes = (await this.health.getSettings()).checkIntervalMin;
    } catch {
      // base de datos caída: se usa el intervalo por omisión y la medición lo reportará
    }
    try {
      await this.health.check();
    } catch (e) {
      this.log.error(`Falló la verificación: ${(e as Error).message}`);
    }
    this.schedule(minutes * 60_000);
  }
}
