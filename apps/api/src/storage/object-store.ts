/** Almacenamiento de objetos (Garage, compatible con S3). Ver docs/decisions/ADR-003. */
export const OBJECT_STORE = Symbol('OBJECT_STORE');

export type ObjectStoreErrorCode =
  /** Faltan las variables S3_*: no hay dónde guardar. Nunca se cae a memoria o a disco. */
  | 'NOT_CONFIGURED'
  /** El almacén no respondió o rechazó la operación. */
  | 'UNAVAILABLE'
  /** El objeto no se puede descifrar o no coincide con lo esperado: fue alterado o cambió la clave. */
  | 'INTEGRITY';

export class ObjectStoreError extends Error {
  constructor(
    readonly code: ObjectStoreErrorCode,
    /** Motivo que dio el servicio (nombre y estado HTTP), sin datos sensibles: sirve para explicar el fallo. */
    readonly detail?: { name: string; status: number | undefined },
  ) {
    super(code);
  }
}

export interface ObjectStore {
  /** Guarda el objeto (ya cifrado por la capa de cifrado). */
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** Devuelve el objeto o `null` si no existe. */
  get(key: string): Promise<Buffer | null>;
}

/** Almacén que además puede borrar objetos: lo usa el archivado (las descargas no borran nada). */
export interface DeletableObjectStore extends ObjectStore {
  delete(key: string): Promise<void>;
}

/** Sin configuración, cada operación falla de forma explícita. */
export class UnconfiguredObjectStore implements DeletableObjectStore {
  put(): Promise<void> {
    return Promise.reject(new ObjectStoreError('NOT_CONFIGURED'));
  }
  get(): Promise<Buffer | null> {
    return Promise.reject(new ObjectStoreError('NOT_CONFIGURED'));
  }
  delete(): Promise<void> {
    return Promise.reject(new ObjectStoreError('NOT_CONFIGURED'));
  }
}
