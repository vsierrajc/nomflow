#!/usr/bin/env node
// Restaura en un bucket los objetos de un respaldo hecho con backup-objects.mjs y comprueba que quedaron
// idénticos (sha256 contra el manifiesto). Con --descifrar, además descifra cada objeto con la clave de la
// aplicación (OBJECT_ENCRYPTION_KEY): demuestra que la clave respaldada corresponde a los objetos.
//
// Uso: node scripts/restore-objects.mjs --from <directorio> --bucket <destino>
//        [--vaciar-ensayo] [--solo-vaciar] [--descifrar]
// Seguridad: el bucket destino debe estar VACÍO. Solo con --vaciar-ensayo se vacía antes, y únicamente si su
// nombre termina en «-ensayo». Nunca borra nada de otro bucket.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const from = arg('from');
const bucket = arg('bucket');
const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
if (!from || !bucket || !S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
  console.error(
    'Uso: restore-objects.mjs --from <directorio> --bucket <destino> [--vaciar-ensayo] [--descifrar]',
  );
  process.exit(2);
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const region = process.env.S3_REGION || 'garage';
const client = new S3Client({
  endpoint: S3_ENDPOINT,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

const manifest = JSON.parse(readFileSync(resolve(from, 'objects.manifest.json'), 'utf8'));
const root = resolve(from, 'objects');

async function listKeys() {
  const keys = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    keys.push(...(page.Contents ?? []).map((o) => o.Key ?? ''));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// 1. El destino debe estar vacío.
let existing = await listKeys();
if (existing.length > 0) {
  if (!flag('vaciar-ensayo') || !bucket.endsWith('-ensayo')) {
    console.error(
      `El bucket ${bucket} no está vacío (${existing.length} objetos). Se rechaza restaurar encima.\n` +
        'Solo un bucket cuyo nombre termina en «-ensayo» se puede vaciar, con --vaciar-ensayo.',
    );
    process.exit(1);
  }
  for (const key of existing)
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  existing = await listKeys();
  if (existing.length > 0) throw new Error('No se pudo vaciar el bucket de ensayo');
}

if (flag('solo-vaciar')) {
  console.log(`Bucket ${bucket} vacío.`);
  process.exit(0);
}

// 2. Restaurar, comprobando antes de subir que el archivo del respaldo coincide con su manifiesto.
const problems = [];
const notIdentical = new Set(); // objetos cuyos bytes no coinciden con el manifiesto
for (const o of manifest.objects) {
  const file = resolve(root, o.key);
  if (!file.startsWith(root + sep)) {
    problems.push(`${o.key}: clave no válida`);
    notIdentical.add(o.key);
    continue;
  }
  const body = readFileSync(file);
  if (body.length !== o.size || sha256(body) !== o.sha256) {
    problems.push(`${o.key}: el archivo del respaldo no coincide con su manifiesto`);
    notIdentical.add(o.key);
    continue;
  }
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: o.key, Body: body, ContentType: o.contentType }),
  );
}

// 3. Verificar lo restaurado: mismos objetos y mismos bytes.
const restoredKeys = new Set(await listKeys());
for (const o of manifest.objects) {
  if (!restoredKeys.has(o.key)) {
    problems.push(`${o.key}: no está en el bucket restaurado`);
    notIdentical.add(o.key);
    continue;
  }
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: o.key }));
  const body = Buffer.from(await res.Body.transformToByteArray());
  if (body.length !== o.size || sha256(body) !== o.sha256) {
    problems.push(`${o.key}: los bytes restaurados no coinciden`);
    notIdentical.add(o.key);
  }
}
const expected = new Set(manifest.objects.map((o) => o.key));
for (const key of restoredKeys)
  if (!expected.has(key)) problems.push(`${key}: sobra en el destino`);

// 4. Descifrar con la clave de la aplicación (si se pide): ella es la que hace útiles los objetos.
let decrypted = 0;
if (flag('descifrar')) {
  const secret = process.env.OBJECT_ENCRYPTION_KEY;
  const require = createRequire(import.meta.url);
  let storage;
  try {
    storage = require(resolve('apps/api/dist/storage/storage.module.js'));
  } catch {
    console.error(
      'Falta compilar la API (npm run build) para descifrar con el código de la aplicación.',
    );
    process.exit(1);
  }
  if (!secret) {
    console.error('Falta OBJECT_ENCRYPTION_KEY para --descifrar.');
    process.exit(1);
  }
  const store = storage.createObjectStore({
    S3_ENDPOINT,
    S3_REGION: region,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    OBJECT_ENCRYPTION_KEY: secret,
  });
  for (const o of manifest.objects) {
    try {
      const plain = await store.get(o.key);
      if (plain === null) problems.push(`${o.key}: no se pudo leer para descifrar`);
      else decrypted += 1;
    } catch {
      problems.push(`${o.key}: no descifra con la clave dada (clave equivocada o objeto alterado)`);
    }
  }
}

console.log(
  `Objetos restaurados en ${bucket}: ${manifest.count}; idénticos al manifiesto: ${manifest.count - notIdentical.size}` +
    (flag('descifrar') ? `; descifrados con la clave: ${decrypted} de ${manifest.count}` : '') +
    '.',
);
if (problems.length > 0) {
  console.error('PROBLEMAS:\n- ' + problems.join('\n- '));
  process.exit(1);
}
