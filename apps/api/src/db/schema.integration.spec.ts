import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { accounts } from './schema';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('esquema de cuentas (PostgreSQL real)', () => {
  const ctx = createDb(url ?? '');

  beforeAll(async () => {
    await runMigrations(url ?? '');
    await ctx.db.execute(sql`TRUNCATE accounts CASCADE`);
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  const base = { passwordHash: 'h' };

  it('rechaza un correo repetido entre cuentas no bloqueadas', async () => {
    await ctx.db.insert(accounts).values({ ...base, nIde: '1', email: 'a@x.co' });
    await expect(
      ctx.db.insert(accounts).values({ ...base, nIde: '2', email: 'a@x.co' }),
    ).rejects.toThrow();
  });

  it('rechaza un N_IDE repetido entre cuentas no bloqueadas', async () => {
    await expect(
      ctx.db.insert(accounts).values({ ...base, nIde: '1', email: 'b@x.co' }),
    ).rejects.toThrow();
  });

  it('permite reutilizar correo y N_IDE tras bloquear la cuenta previa', async () => {
    await ctx.db.execute(sql`UPDATE accounts SET status = 'BLOQUEADA' WHERE n_ide = '1'`);
    await ctx.db.insert(accounts).values({ ...base, nIde: '1', email: 'a@x.co' });
  });
});
