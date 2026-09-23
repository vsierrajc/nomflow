import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { createDb } from './client';

export const DB = Symbol('DB');
const POOL = Symbol('POOL');

@Global()
@Module({
  providers: [
    {
      provide: POOL,
      useFactory: () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL requerido');
        return createDb(url);
      },
    },
    { provide: DB, useFactory: (c: ReturnType<typeof createDb>) => c.db, inject: [POOL] },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly ctx: { pool: Pool }) {}
  async onApplicationShutdown(): Promise<void> {
    await this.ctx.pool.end();
  }
}
