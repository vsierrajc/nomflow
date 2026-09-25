import { ObjectStoreError, type DeletableObjectStore, type ObjectStore } from './object-store';

/** Entrega el almacén en la nube si está configurado; null si no lo está. */
export interface ColdStoreProvider {
  get(): Promise<DeletableObjectStore | null>;
}

/**
 * Almacén por niveles (ADR-004): lo reciente vive en local (Garage) y lo histórico en la nube.
 * Se escribe siempre en local. Al leer, si no está en local se busca en la nube, de forma transparente.
 * Si el objeto no está en local y la nube no responde, no se puede afirmar que no existe: falla como
 * no disponible en lugar de devolver «no encontrado».
 * Va por debajo del cifrado: en la nube solo hay bytes ya cifrados por la aplicación.
 */
export class TieredObjectStore implements ObjectStore {
  constructor(
    private readonly hot: ObjectStore,
    private readonly cold: ColdStoreProvider,
  ) {}

  put(key: string, data: Buffer, contentType?: string): Promise<void> {
    return this.hot.put(key, data, contentType);
  }

  async get(key: string): Promise<Buffer | null> {
    const local = await this.hot.get(key);
    if (local !== null) return local;
    let cold: DeletableObjectStore | null;
    try {
      cold = await this.cold.get();
    } catch {
      throw new ObjectStoreError('UNAVAILABLE');
    }
    return cold ? cold.get(key) : null;
  }
}
