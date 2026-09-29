import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import { OBJECT_STORE } from '../storage/object-store';
import type { ObjectStore } from '../storage/object-store';
import { assembleZip, pendingExports } from './export-zip.service';

/** Arma en segundo plano los ZIP pendientes. Un job liviano en proceso, sin cola de trabajos. */
@Injectable()
export class ExportZipMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ExportZipMonitor');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  private enabled(): boolean {
    return (
      process.env.EXIT_EXPORT_MONITOR !== 'off' &&
      process.env.NODE_ENV !== 'test' &&
      !process.env.VITEST
    );
  }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.schedule(Number(process.env.EXIT_EXPORT_MONITOR_START_DELAY_MS ?? 15_000));
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

  async runOnce(): Promise<{ processed: number }> {
    const ids = await pendingExports(this.db);
    for (const id of ids) await assembleZip(this.db, this.store, id);
    return { processed: ids.length };
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (e) {
      this.log.error(`Falló la generación de exportaciones: ${(e as Error).message}`);
    }
    this.schedule(Number(process.env.EXIT_EXPORT_MONITOR_INTERVAL_MS ?? 300_000));
  }
}
