import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ObjectStoreError, type ObjectStore } from './object-store';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Configuración desde el entorno, o null si falta algo (entonces no hay almacenamiento). */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: S3_ENDPOINT,
    region: env.S3_REGION || 'garage',
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  };
}

/** Cliente de la API S3 (Garage). Solo habla de objetos: no cifra ni conoce documentos. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true, // Garage y los almacenes locales usan direcciones con el bucket en la ruta
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 20_000 },
    });
  }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
    } catch {
      throw new ObjectStoreError('UNAVAILABLE');
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw new ObjectStoreError('UNAVAILABLE');
    }
  }
}
