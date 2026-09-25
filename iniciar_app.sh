#!/usr/bin/env bash
# Inicia NOMFLOW en local: levanta PostgreSQL, Redis, MinIO y Mailpit en Docker, compila,
# aplica las migraciones y arranca la API y la web. Equivale a: docker compose up + arranque.
#
#   ./iniciar_app.sh
#
# Web  http://localhost:3000   API  http://localhost:4000/health   Mailpit  http://localhost:8025
# Para detenerla: ./detener_app.sh
set -euo pipefail
cd "$(dirname "$0")"
exec bash scripts/stack.sh up
