import { eq } from 'drizzle-orm';
import { hashPassword } from '../accounts/password.service';
import { createDb } from './client';
import { accounts, roleAssignments } from './schema';

const MIN_LENGTH = 12;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const nIde = process.env.BOOTSTRAP_ADMIN_ID?.trim() || 'ADMIN';
  if (!url || !email || !password) {
    throw new Error('Requeridos: DATABASE_URL, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD');
  }
  if (password.length < MIN_LENGTH)
    throw new Error(`La clave debe tener al menos ${MIN_LENGTH} caracteres`);

  const { db, pool } = createDb(url);
  try {
    const [exists] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.email, email));
    if (exists) throw new Error('Ya existe una cuenta con ese correo');
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({
          nIde,
          email,
          passwordHash: await hashPassword(password),
          status: 'ACTIVA',
          mustChangePassword: false,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: accounts.id });
      if (!row) throw new Error('cuenta no creada');
      await tx.insert(roleAssignments).values({
        accountId: row.id,
        role: 'HR_ADMIN',
        validFrom: new Date().toISOString().slice(0, 10),
      });
    });
    console.log(`Administrador creado: ${email}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'error');
  process.exit(1);
});
