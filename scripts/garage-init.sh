#!/usr/bin/env bash
# Prepara Garage para NOMFLOW de forma idempotente: asigna el diseño del nodo, crea el bucket,
# importa la clave de la aplicación y le da permisos. Se puede ejecutar todas las veces que haga falta.
#
# Variables: S3_BUCKET, S3_ACCESS_KEY_ID (GK + 24 hex), S3_SECRET_ACCESS_KEY (64 hex).
# GARAGE_EXEC: cómo ejecutar el CLI de Garage (por defecto, el servicio de docker compose;
# en el CI: "docker exec garage /garage").
set -euo pipefail
cd "$(dirname "$0")/.."

: "${S3_BUCKET:?falta S3_BUCKET}" "${S3_ACCESS_KEY_ID:?falta S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY:?falta S3_SECRET_ACCESS_KEY}"
GARAGE_EXEC="${GARAGE_EXEC:-docker compose exec -T garage /garage}"
# El CLI escribe trazas informativas por stderr; se descartan para no ensuciar la salida.
g() { $GARAGE_EXEC "$@" 2>/dev/null; }

for _ in $(seq 1 60); do
  g status >/dev/null && break
  sleep 1
done
g status >/dev/null || { echo "Garage no responde" >&2; exit 1; }

if g status | grep -q "NO ROLE ASSIGNED"; then
  node_id="$(g node id -q | cut -d@ -f1)"
  g layout assign -z dc1 -c "${GARAGE_CAPACITY:-1G}" "$node_id" >/dev/null
  version="$(g layout show | grep -oE 'ersion: [0-9]+' | head -1 | grep -oE '[0-9]+' || echo 0)"
  g layout apply --version "$((version + 1))" >/dev/null
  echo "Garage: diseño del nodo asignado."
fi

g bucket info "$S3_BUCKET" >/dev/null || { g bucket create "$S3_BUCKET" >/dev/null; echo "Garage: bucket $S3_BUCKET creado."; }
g key info "$S3_ACCESS_KEY_ID" >/dev/null \
  || { g key import --yes -n nomflow-app "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null; echo "Garage: clave de la aplicación importada."; }
g bucket allow --read --write --owner "$S3_BUCKET" --key "$S3_ACCESS_KEY_ID" >/dev/null

# Bucket aparte para las pruebas (navegador e integración), para no mezclar sus objetos con los de desarrollo.
TEST_BUCKET="${S3_TEST_BUCKET:-nomflow-test}"
g bucket info "$TEST_BUCKET" >/dev/null || g bucket create "$TEST_BUCKET" >/dev/null
g bucket allow --read --write --owner "$TEST_BUCKET" --key "$S3_ACCESS_KEY_ID" >/dev/null
echo "Garage listo: buckets $S3_BUCKET y $TEST_BUCKET."
