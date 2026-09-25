import { Global, Logger, Module } from '@nestjs/common';
import type { Db } from '../db/client';
import { DB } from '../db/db.module';
import {
  COLD_STORE_FACTORY,
  DbColdStoreProvider,
  defaultColdFactory,
  type ColdStoreFactory,
} from './archive-settings.service';
import { EncryptedObjectStore, objectEncryptionSecret } from './encrypted-object-store';
import {
  OBJECT_STORE,
  UnconfiguredObjectStore,
  type DeletableObjectStore,
  type ObjectStore,
} from './object-store';
import { S3ObjectStore, s3ConfigFromEnv } from './s3-object-store';
import { TieredObjectStore, type ColdStoreProvider } from './tiered-object-store';

/** Almacén local sin cifrar (Garage), o «sin configurar»: nunca memoria ni disco. */
export const RAW_HOT_STORE = Symbol('RAW_HOT_STORE');
/** Proveedor del almacén en la nube (archivo histórico, ADR-004). */
export const COLD_PROVIDER = Symbol('COLD_PROVIDER');

export function createRawHotStore(env: NodeJS.ProcessEnv = process.env): DeletableObjectStore {
  const config = s3ConfigFromEnv(env);
  return config ? new S3ObjectStore(config) : new UnconfiguredObjectStore();
}

/** Cifrado sobre el almacén (por niveles si hay proveedor en la nube). Sin clave propia no se activa. */
export function encryptedStore(
  hot: ObjectStore,
  cold: ColdStoreProvider | null,
  env: NodeJS.ProcessEnv = process.env,
): ObjectStore {
  if (hot instanceof UnconfiguredObjectStore) return hot;
  const secret = objectEncryptionSecret(env);
  if (secret.length < 32) {
    // Sin clave propia no se guarda nada: usar otra clave haría ilegibles los documentos al rotarla.
    new Logger('Storage').error(
      'OBJECT_ENCRYPTION_KEY falta o tiene menos de 32 caracteres: el almacén de objetos queda sin configurar.',
    );
    return new UnconfiguredObjectStore();
  }
  return new EncryptedObjectStore(cold ? new TieredObjectStore(hot, cold) : hot, secret);
}

/** Solo local (sin nube): pruebas y comandos de mantenimiento. */
export function createObjectStore(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  return encryptedStore(createRawHotStore(env), null, env);
}

@Global()
@Module({
  providers: [
    { provide: RAW_HOT_STORE, useFactory: () => createRawHotStore() },
    { provide: COLD_STORE_FACTORY, useValue: defaultColdFactory },
    {
      provide: COLD_PROVIDER,
      useFactory: (db: Db, f: ColdStoreFactory) => new DbColdStoreProvider(db, f),
      inject: [DB, COLD_STORE_FACTORY],
    },
    {
      provide: OBJECT_STORE,
      useFactory: (hot: DeletableObjectStore, cold: ColdStoreProvider) => encryptedStore(hot, cold),
      inject: [RAW_HOT_STORE, COLD_PROVIDER],
    },
  ],
  exports: [OBJECT_STORE, RAW_HOT_STORE, COLD_PROVIDER, COLD_STORE_FACTORY],
})
export class StorageModule {}
