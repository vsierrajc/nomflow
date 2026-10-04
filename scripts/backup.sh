#!/usr/bin/env bash
# Respaldo de NOMFLOW: PostgreSQL (pg_dump, formato custom) y los objetos de Garage (copia por la API S3 con
# manifiesto y sha256). Deja todo en backups/<fecha UTC>/ (ignorado por git, permisos 700/600).
#
#   npm run backup                      # usa DATABASE_URL y S3_* del .env
#   DATABASE_URL=... S3_BUCKET=... npm run backup   # lo que venga del entorno manda sobre el .env
#
# NO incluye OBJECT_ENCRYPTION_KEY ni el .env: sin la clave los objetos respaldados son ilegibles, y la
# clave se guarda aparte y fuera del servidor (docs/backup-clave-objetos.md). Ver docs/respaldo-y-restauracion.md.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

# Valor de una variable: del entorno o, si no está, del .env (sin ejecutarlo ni imprimirlo).
envval() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f .env ]; then
    v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)"
  fi
  printf '%s' "$v"
}

DATABASE_URL="$(envval DATABASE_URL)"
: "${DATABASE_URL:?falta DATABASE_URL (en el entorno o en .env)}"
rest="${DATABASE_URL#*://}"; PGUSER_="${rest%%:*}"; DB="${DATABASE_URL##*/}"; DB="${DB%%\?*}"
# PG_EXEC: cómo ejecutar los clientes de PostgreSQL (por defecto, el servicio de docker compose).
PG_EXEC="${PG_EXEC:-docker compose exec -T postgres}"
pg() { $PG_EXEC "$@"; }

# Recuento de filas por tabla (esquema public y el registro de migraciones), para comparar tras restaurar.
counts() {
  pg psql -U "$PGUSER_" -d "$1" -At -F $'\t' -c "
    select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    union all
    select 'drizzle.__drizzle_migrations', count(*)::text from drizzle.__drizzle_migrations
    order by 1"
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="${BACKUP_ROOT:-backups}/$STAMP"
mkdir -p "$DIR"
echo "Respaldo en $DIR (base $DB)"

counts "$DB" > "$DIR/postgres.counts.before.tsv"
pg pg_dump -U "$PGUSER_" -d "$DB" -Fc --no-owner > "$DIR/postgres.dump"
counts "$DB" > "$DIR/postgres.counts.after.tsv"
[ -s "$DIR/postgres.dump" ] || { echo "El volcado de PostgreSQL salió vacío" >&2; exit 1; }
echo "PostgreSQL: $(wc -c < "$DIR/postgres.dump") bytes, $(wc -l < "$DIR/postgres.counts.after.tsv") tablas."

OBJECTS=0
S3_BUCKET_="$(envval S3_BUCKET)"
if [ -n "$S3_BUCKET_" ] && [ -n "$(envval S3_ENDPOINT)" ]; then
  S3_ENDPOINT="$(envval S3_ENDPOINT)" S3_REGION="$(envval S3_REGION)" S3_BUCKET="$S3_BUCKET_" \
    S3_ACCESS_KEY_ID="$(envval S3_ACCESS_KEY_ID)" S3_SECRET_ACCESS_KEY="$(envval S3_SECRET_ACCESS_KEY)" \
    node scripts/backup-objects.mjs --out "$DIR"
  OBJECTS="$(DIR="$DIR" node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.DIR + '/objects.manifest.json', 'utf8')).count)")"
else
  echo "Aviso: sin S3_* no se respaldan objetos (certificados y constancias)." >&2
fi

DUMP_SHA="$(sha256sum "$DIR/postgres.dump" | cut -d' ' -f1)"
DIR="$DIR" DB="$DB" OBJECTS="$OBJECTS" DUMP_SHA="$DUMP_SHA" BUCKET="$S3_BUCKET_" \
  COMMIT="$(git rev-parse HEAD 2>/dev/null || echo desconocido)" node -e "
    const fs = require('fs');
    const e = process.env;
    fs.writeFileSync(e.DIR + '/MANIFEST.json', JSON.stringify({
      createdAt: new Date().toISOString(),
      database: e.DB,
      postgresDumpSha256: e.DUMP_SHA,
      objectsBucket: e.BUCKET || null,
      objects: Number(e.OBJECTS),
      gitCommit: e.COMMIT,
    }, null, 2));
  "
cat > "$DIR/LEAME.txt" <<TXT
Respaldo de NOMFLOW del $STAMP (UTC).

Contiene: postgres.dump (pg_dump -Fc de la base $DB), recuentos de filas, y los objetos de Garage tal como
están guardados (cifrados por la aplicación) con su manifiesto.

NO contiene (se guardan aparte, fuera del servidor):
  - OBJECT_ENCRYPTION_KEY: sin ella los objetos no se pueden descifrar (docs/backup-clave-objetos.md).
  - El archivo .env (SESSION_SECRET, claves de Garage, SMTP).
  - Los objetos que el archivo histórico movió a la nube: viven en el proveedor de ese archivo.

Este respaldo tiene datos personales: guárdelo cifrado y con acceso restringido.
Cómo restaurar y cómo ensayarlo: docs/respaldo-y-restauracion.md
TXT
echo "Respaldo completo: $DIR (objetos: $OBJECTS)"
