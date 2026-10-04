#!/usr/bin/env node
// Copia todos los objetos de un bucket (Garage/S3) a un directorio, con un manifiesto de clave, tamaño y
// sha256. Los objetos ya están cifrados por la aplicación: la copia guarda los bytes tal cual (ilegibles sin
// OBJECT_ENCRYPTION_KEY, que se respalda aparte; ver docs/backup-clave-objetos.md).
//
// Uso: node scripts/backup-objects.mjs --out <directorio> [--bucket <nombre>]
// Variables: S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = arg('out');
const bucket = arg('bucket') ?? process.env.S3_BUCKET;
const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
if (!out || !bucket || !S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.error(
    'Uso: backup-objects.mjs --out <directorio> [--bucket <nombre>]\n' +
      'Hacen falta S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY y S3_BUCKET.',
  );
  process.exit(2);
}

const client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: process.env.S3_REGION || 'garage',
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

const root = resolve(out, 'objects');
mkdirSync(root, { recursive: true, mode: 0o700 });

const objects = [];
let token;
do {
  const page = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
  );
  for (const item of page.Contents ?? []) {
    const key = item.Key ?? '';
    const target = resolve(root, key);
    // Una clave con «..» o ruta absoluta no puede escribir fuera del directorio del respaldo.
    if (!key || !target.startsWith(root + sep))
      throw new Error(`Clave de objeto no válida: ${key}`);
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await res.Body.transformToByteArray());
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, body, { mode: 0o600 });
    objects.push({
      key,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      contentType: res.ContentType ?? 'application/octet-stream',
    });
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

objects.sort((a, b) => a.key.localeCompare(b.key));
const manifest = {
  bucket,
  createdAt: new Date().toISOString(),
  count: objects.length,
  bytes: objects.reduce((sum, o) => sum + o.size, 0),
  objects,
};
writeFileSync(join(resolve(out), 'objects.manifest.json'), JSON.stringify(manifest, null, 2), {
  mode: 0o600,
});
console.log(
  `Objetos respaldados: ${manifest.count} (${manifest.bytes} bytes) del bucket ${bucket}.`,
);
