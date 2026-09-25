import { Global, Logger, Module } from '@nestjs/common';
import { EncryptedObjectStore, objectEncryptionSecret } from './encrypted-object-store';
import { OBJECT_STORE, UnconfiguredObjectStore, type ObjectStore } from './object-store';
import { S3ObjectStore, s3ConfigFromEnv } from './s3-object-store';

/** Almacén de objetos de la aplicación: Garage cifrado, o «sin configurar» (nunca memoria ni disco). */
export function createObjectStore(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  const config = s3ConfigFromEnv(env);
  if (!config) return new UnconfiguredObjectStore();
  const secret = objectEncryptionSecret(env);
  if (secret.length < 32) {
    // Sin clave propia no se guarda nada: usar otra clave haría ilegibles los documentos al rotarla.
    new Logger('Storage').error(
      'OBJECT_ENCRYPTION_KEY falta o tiene menos de 32 caracteres: el almacén de objetos queda sin configurar.',
    );
    return new UnconfiguredObjectStore();
  }
  return new EncryptedObjectStore(new S3ObjectStore(config), secret);
}

@Global()
@Module({
  providers: [{ provide: OBJECT_STORE, useFactory: () => createObjectStore() }],
  exports: [OBJECT_STORE],
})
export class StorageModule {}
