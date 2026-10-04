#!/usr/bin/env bash
# Ensayo de restauración: restaura un respaldo (scripts/backup.sh) en una base y un bucket DE ENSAYO, nunca en los
# reales, y comprueba que quedó completo:
#   - PostgreSQL: pg_restore sin errores y mismo número de filas en cada tabla que al respaldar.
#   - Migraciones: cuántas trae el respaldo frente al código actual (y si faltan, se aplican en la base de ensayo).
#   - Objetos: los mismos bytes del manifiesto y, con OBJECT_ENCRYPTION_KEY, cada uno descifra.
#
#   npm run restore:ensayo -- backups/<fecha> [--reemplazar] [--limpiar]
#
#   --reemplazar  si ya existen la base <db>_ensayo o el bucket <bucket>-ensayo de un ensayo anterior, los reemplaza
#                 (solo se borra lo que termina en «_ensayo» / «-ensayo»).
#   ENSAYO_DB     nombre de la base de ensayo (por omisión <db>_ensayo); siempre debe terminar en «_ensayo».
#   --limpiar     al terminar bien, borra la base y los objetos de ensayo.
# Ver docs/respaldo-y-restauracion.md.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP="${1:-}"; shift || true
REEMPLAZAR=0; LIMPIAR=0
for a in "$@"; do
  case "$a" in
    --reemplazar) REEMPLAZAR=1 ;;
    --limpiar) LIMPIAR=1 ;;
    *) echo "Opción desconocida: $a" >&2; exit 2 ;;
  esac
done
[ -n "$BACKUP" ] && [ -f "$BACKUP/postgres.dump" ] && [ -f "$BACKUP/MANIFEST.json" ] \
  || { echo "Uso: restore-ensayo.sh <directorio de respaldo> [--reemplazar] [--limpiar]" >&2; exit 2; }

envval() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f .env ]; then
    v="$(grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)"
  fi
  printf '%s' "$v"
}
mf() { BK="$BACKUP" node -p "const v = require('node:path').resolve(process.env.BK, 'MANIFEST.json'); const x = JSON.parse(require('node:fs').readFileSync(v, 'utf8'))['$1']; x === null ? '' : x"; }

DB_SRC="$(mf database)"
SCRATCH="${ENSAYO_DB:-${DB_SRC}_ensayo}"
case "$SCRATCH" in *_ensayo) ;; *) echo "Nombre de base de ensayo no válido: $SCRATCH" >&2; exit 2 ;; esac
DATABASE_URL="$(envval DATABASE_URL)"; : "${DATABASE_URL:?falta DATABASE_URL}"
rest="${DATABASE_URL#*://}"; PGUSER_="${rest%%:*}"
PG_EXEC="${PG_EXEC:-docker compose exec -T postgres}"
pg() { $PG_EXEC "$@"; }
FAIL=0
bad() { echo "  ✗ $*" >&2; FAIL=$((FAIL + 1)); }
ok() { echo "  ✓ $*"; }

echo "Ensayo de restauración de $BACKUP"
echo "Base de ensayo: $SCRATCH (la base real $DB_SRC no se toca)"

# 0. El volcado es el mismo que se respaldó.
if [ "$(sha256sum "$BACKUP/postgres.dump" | cut -d' ' -f1)" = "$(mf postgresDumpSha256)" ]; then
  ok "huella del volcado coincide con el manifiesto"
else
  echo "  ✗ el volcado no coincide con su manifiesto (archivo alterado o dañado): no se restaura nada" >&2
  echo "ENSAYO FALLÓ (respaldo no confiable)" >&2
  exit 1
fi

# 1. Crear la base de ensayo vacía.
if [ "$(pg psql -U "$PGUSER_" -d postgres -At -c "select 1 from pg_database where datname = '$SCRATCH'")" = "1" ]; then
  [ "$REEMPLAZAR" = 1 ] || { echo "Ya existe la base $SCRATCH de un ensayo anterior. Use --reemplazar o bórrela a mano." >&2; exit 1; }
  pg psql -U "$PGUSER_" -d postgres -q -c "drop database \"$SCRATCH\" with (force)"
fi
pg psql -U "$PGUSER_" -d postgres -q -c "create database \"$SCRATCH\""

# 2. Restaurar.
if pg pg_restore -U "$PGUSER_" -d "$SCRATCH" --no-owner --exit-on-error < "$BACKUP/postgres.dump"; then
  ok "pg_restore terminó sin errores"
else
  bad "pg_restore falló"
fi

# 3. Mismo número de filas que al respaldar (entre el recuento previo y el posterior al volcado).
if ! pg psql -U "$PGUSER_" -d "$SCRATCH" -At -F $'\t' -c "
  select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
  union all
  select 'drizzle.__drizzle_migrations', count(*)::text from drizzle.__drizzle_migrations
  order by 1" > "$BACKUP/postgres.counts.restored.tsv"; then
  bad "no se pudieron contar las filas de la base restaurada (¿quedó vacía o incompleta?)"
  : > "$BACKUP/postgres.counts.restored.tsv"
fi
DIFFS="$(awk -F'\t' '
  FILENAME == ARGV[1] { b[$1] = $2; next }
  FILENAME == ARGV[2] { a[$1] = $2; next }
  { r[$1] = $2 }
  END {
    for (t in a) { lo = (b[t] < a[t]) ? b[t] : a[t]; hi = (b[t] < a[t]) ? a[t] : b[t];
      if (!(t in r) || r[t] + 0 < lo + 0 || r[t] + 0 > hi + 0) printf "%s: respaldo %s..%s, restaurado %s\n", t, lo, hi, (t in r) ? r[t] : "falta" }
    for (t in r) if (!(t in a)) printf "%s: sobra en lo restaurado\n", t
  }' "$BACKUP/postgres.counts.before.tsv" "$BACKUP/postgres.counts.after.tsv" "$BACKUP/postgres.counts.restored.tsv")"
TABLES="$(wc -l < "$BACKUP/postgres.counts.after.tsv")"
ROWS="$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$BACKUP/postgres.counts.restored.tsv")"
if [ -z "$DIFFS" ]; then ok "$TABLES tablas, $ROWS filas: coinciden con el respaldo"; else bad "recuentos distintos:"; echo "$DIFFS" | sed 's/^/      /' >&2; fi

# 4. Migraciones: lo que trae el respaldo frente al código.
HAVE="$(awk -F'\t' '$1 == "drizzle.__drizzle_migrations" { print $2 }' "$BACKUP/postgres.counts.restored.tsv")"
HAVE="${HAVE:-0}"
CODE="$(node -p "require('./apps/api/migrations/meta/_journal.json').entries.length")"
if [ "$HAVE" -eq "$CODE" ]; then
  ok "migraciones: $HAVE de $CODE (el respaldo está al día con el código)"
elif [ "$HAVE" -lt "$CODE" ] && [ -f apps/api/dist/db/migrate.js ]; then
  if DATABASE_URL="${DATABASE_URL%/*}/$SCRATCH" node apps/api/dist/db/migrate.js >/dev/null 2>&1; then
    ok "migraciones: el respaldo tenía $HAVE de $CODE; las $((CODE - HAVE)) pendientes se aplicaron sin error en la base de ensayo"
  else
    bad "migraciones: el respaldo tenía $HAVE de $CODE y las pendientes fallaron al aplicarse"
  fi
elif [ "$HAVE" -lt "$CODE" ]; then
  echo "  · migraciones: el respaldo tiene $HAVE de $CODE (compile la API con «npm run build» para aplicarlas en el ensayo)"
else
  bad "migraciones: el respaldo trae $HAVE y el código solo $CODE (¿código más antiguo que el respaldo?)"
fi

# 5. Objetos.
BUCKET_SRC="$(mf objectsBucket)"
if [ -f "$BACKUP/objects.manifest.json" ] && [ -n "$BUCKET_SRC" ]; then
  SCRATCH_BUCKET="${BUCKET_SRC}-ensayo"
  export S3_ENDPOINT="$(envval S3_ENDPOINT)" S3_REGION="$(envval S3_REGION)" \
    S3_ACCESS_KEY_ID="$(envval S3_ACCESS_KEY_ID)" S3_SECRET_ACCESS_KEY="$(envval S3_SECRET_ACCESS_KEY)" \
    OBJECT_ENCRYPTION_KEY="$(envval OBJECT_ENCRYPTION_KEY)"
  GARAGE_EXEC="${GARAGE_EXEC:-docker compose exec -T garage /garage}"
  g() { $GARAGE_EXEC "$@" 2>/dev/null; }
  g bucket info "$SCRATCH_BUCKET" >/dev/null || g bucket create "$SCRATCH_BUCKET" >/dev/null
  g bucket allow --read --write --owner "$SCRATCH_BUCKET" --key "$S3_ACCESS_KEY_ID" >/dev/null
  ARGS=(--from "$BACKUP" --bucket "$SCRATCH_BUCKET")
  [ "$REEMPLAZAR" = 1 ] && ARGS+=(--vaciar-ensayo)
  if [ -n "$OBJECT_ENCRYPTION_KEY" ] && [ -f apps/api/dist/storage/storage.module.js ]; then
    ARGS+=(--descifrar)
  else
    echo "  · sin OBJECT_ENCRYPTION_KEY o sin compilar la API: no se descifra (solo se compara con el manifiesto)"
  fi
  if OUT="$(node scripts/restore-objects.mjs "${ARGS[@]}" 2>&1)"; then ok "$OUT"; else bad "objetos:"; echo "$OUT" | sed 's/^/      /' >&2; fi
else
  echo "  · el respaldo no trae objetos: se omite esa parte"
fi

# 6. Limpieza opcional (solo lo de ensayo).
if [ "$LIMPIAR" = 1 ] && [ "$FAIL" = 0 ]; then
  pg psql -U "$PGUSER_" -d postgres -q -c "drop database \"$SCRATCH\" with (force)"
  if [ -n "${SCRATCH_BUCKET:-}" ]; then
    node scripts/restore-objects.mjs --from "$BACKUP" --bucket "$SCRATCH_BUCKET" --vaciar-ensayo --solo-vaciar >/dev/null
    g bucket delete --yes "$SCRATCH_BUCKET" >/dev/null || true
  fi
  echo "  · limpieza: base y bucket de ensayo borrados"
fi

if [ "$FAIL" = 0 ]; then echo "ENSAYO OK"; else echo "ENSAYO FALLÓ ($FAIL problema(s))" >&2; exit 1; fi
