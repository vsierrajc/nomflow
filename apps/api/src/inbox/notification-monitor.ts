import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { NotificationService } from './notification.service';

/** Cada minuto revisa si hay avisos o recordatorios por enviar. */
@Injectable()
export class NotificationMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('NotificationMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(@Inject(NotificationService) private readonly notifications: NotificationService) {}

  private enabled(): boolean {
    return (
      process.env.NOTIFICATIONS_MONITOR !== 'off' &&
      process.env.NODE_ENV !== 'test' &&
      !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (this.enabled()) this.schedule(Number(process.env.NOTIFICATIONS_START_DELAY_MS ?? 45_000));
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
      await this.notifications.sweep();
    } catch (e) {
      this.log.error(`Falló el envío de avisos: ${(e as Error).message}`);
    }
    this.schedule(60_000);
  }
}
