import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { todayBogota } from './business-days';
import { runVacationCycles } from './vacation-cycle.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Una vez al día genera el período de vacaciones (15 días) del ciclo de 360 días que se cumpla, por cada
 * contrato vigente, y marca VENCIDA la más antigua cuando el tope de acumulación se supera.
 */
@Injectable()
export class VacationCycleMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('VacationCycleMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(@Inject(DB) private readonly db: Db) {}

  private enabled(): boolean {
    return (
      process.env.VACATION_CYCLE_MONITOR !== 'off' &&
      process.env.NODE_ENV !== 'test' &&
      !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (this.enabled()) this.schedule(Number(process.env.VACATION_CYCLE_START_DELAY_MS ?? 60_000));
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
      const r = await runVacationCycles(this.db, todayBogota());
      if (r.created > 0 || r.expired > 0)
        this.log.log(
          `Ciclos de vacaciones: ${r.created} período(s) creado(s), ${r.expired} vencido(s) de ${r.contracts} contratos revisados.`,
        );
    } catch (e) {
      this.log.error(`Falló la generación de ciclos: ${(e as Error).message}`);
    }
    this.schedule(Number(process.env.VACATION_CYCLE_INTERVAL_MS ?? DAY_MS));
  }
}
