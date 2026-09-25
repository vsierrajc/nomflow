import { ObjectStoreError, type ObjectStore } from './object-store';

/** Almacén en memoria para las pruebas. No se usa nunca como respaldo de la configuración real. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  /** Simula que el almacén no responde. */
  down = false;

  put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    if (this.down) return Promise.reject(new ObjectStoreError('UNAVAILABLE'));
    this.objects.set(key, { data: Buffer.from(data), contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | null> {
    if (this.down) return Promise.reject(new ObjectStoreError('UNAVAILABLE'));
    const o = this.objects.get(key);
    return Promise.resolve(o ? Buffer.from(o.data) : null);
  }
}
