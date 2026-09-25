#!/usr/bin/env bash
# Stack local de NOMFLOW: PostgreSQL, Redis, Garage (S3) y Mailpit en Docker; API y web como procesos locales.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN=.run
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"
mkdir -p "$RUN"

ensure_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    local secret
    secret="$(openssl rand -base64 48 | tr -d '\n')"
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${secret}|" .env
    echo "Creado .env local (ignorado por git) con un SESSION_SECRET aleatorio."
  fi
  migrate_env
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
}

# Añade a un .env existente lo que falte (credenciales de Garage) y quita lo de MinIO, ya retirado.
migrate_env() {
  add_var() { grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env; }
  if grep -q '^S3_ENDPOINT=.*:9100' .env; then sed -i 's|^S3_ENDPOINT=.*|S3_ENDPOINT=http://localhost:3900|' .env; fi
  sed -i '/^MINIO_ROOT_/d' .env
  add_var S3_ENDPOINT "http://localhost:3900"
  add_var S3_REGION "garage"
  add_var S3_BUCKET "nomflow-private"
  add_var S3_TEST_BUCKET "nomflow-test"
  add_var S3_ACCESS_KEY_ID "GK$(openssl rand -hex 12)"
  add_var S3_SECRET_ACCESS_KEY "$(openssl rand -hex 32)"
  add_var GARAGE_RPC_SECRET "$(openssl rand -hex 32)"
  add_var GARAGE_ADMIN_TOKEN "$(openssl rand -hex 24)"
}

pid_alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

stop_proc() {
  if pid_alive "$1"; then
    kill -- "-$(cat "$RUN/$1.pid")" 2>/dev/null || kill "$(cat "$RUN/$1.pid")" 2>/dev/null || true
    echo "detenido: $1"
  fi
  rm -f "$RUN/$1.pid"
}

start_proc() {
  local name="$1"
  shift
  setsid nohup "$@" >"$RUN/$name.log" 2>&1 </dev/null &
  echo $! >"$RUN/$name.pid"
}

wait_url() {
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "$1"; then return 0; fi
    sleep 0.5
  done
  echo "no responde: $1 (ver $RUN/$2.log)" >&2
  return 1
}

up() {
  ensure_env
  docker compose up -d --remove-orphans postgres redis garage mailpit
  for _ in $(seq 1 40); do
    docker compose exec -T postgres pg_isready -U nomflow >/dev/null 2>&1 && break
    sleep 0.5
  done
  docker compose exec -T postgres psql -U nomflow -tc "select 1 from pg_database where datname='nomflow_test'" | grep -q 1 \
    || docker compose exec -T postgres psql -U nomflow -c "create database nomflow_test" >/dev/null

  bash scripts/garage-init.sh

  [ -d node_modules ] || npm ci --no-audit --no-fund
  npm run build
  npm run db:migrate -w @nomflow/api

  stop_proc api
  stop_proc web
  PORT="$API_PORT" start_proc api node apps/api/dist/main.js
  start_proc web npm run start -w @nomflow/web -- -p "$WEB_PORT"
  wait_url "http://localhost:${API_PORT}/health" api
  wait_url "http://localhost:${WEB_PORT}" web
  status
}

down() {
  if [ "${1:-}" = "--borrar-datos" ]; then
    echo "ATENCIÓN: se eliminarán los contenedores y sus VOLÚMENES: la base de desarrollo (nomflow y nomflow_test) y los documentos guardados en Garage."
    printf 'Escriba BORRAR para confirmar: '
    read -r answer
    if [ "$answer" != "BORRAR" ]; then
      echo "Cancelado: no se detuvo ni se borró nada." >&2
      return 1
    fi
    stop_proc web
    stop_proc api
    docker compose down -v
  else
    stop_proc web
    stop_proc api
    # Elimina los contenedores y la red, pero conserva los datos (volúmenes).
    docker compose down
  fi
}

status() {
  echo "API      http://localhost:${API_PORT}/health  $(pid_alive api && echo 'en ejecución' || echo 'detenida')"
  echo "Web      http://localhost:${WEB_PORT}         $(pid_alive web && echo 'en ejecución' || echo 'detenida')"
  echo "Mailpit  http://localhost:8025  (SMTP 1025)"
  echo "Garage   S3 http://localhost:3900  (administración http://localhost:3903)"
  echo "Postgres localhost:5432   Redis localhost:6379"
  docker compose ps --format 'table {{.Service}}\t{{.Status}}'
}

case "${1:-}" in
  up) up ;;
  down) down "${2:-}" ;;
  status) ensure_env; status ;;
  *) echo "Uso: bash scripts/stack.sh {up|down [--borrar-datos]|status}" >&2; exit 1 ;;
esac
