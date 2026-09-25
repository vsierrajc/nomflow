import { createDb } from '../db/client';
import { migrateTaxCertificatesToStore } from '../tax/tax.service';
import { createObjectStore } from './storage.module';

/** Pasa al almacén de objetos los documentos que aún viven en la base. Se puede repetir sin riesgo. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const { db, pool } = createDb(url);
  try {
    const r = await migrateTaxCertificatesToStore(db, createObjectStore());
    console.log(`Certificados de retención: ${r.migrated} de ${r.found} pasados al almacén de objetos.`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
