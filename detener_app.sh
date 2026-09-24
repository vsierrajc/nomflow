#!/usr/bin/env bash
# Detiene NOMFLOW: para la API y la web y elimina los contenedores y la red de Docker
# (equivale a: docker compose down). Los DATOS SE CONSERVAN: la próxima vez que use
# ./iniciar_app.sh la base de datos estará como se dejó.
#
#   ./detener_app.sh                  detiene todo y conserva los datos
#   ./detener_app.sh --borrar-datos   además BORRA los volúmenes (docker compose down -v);
#                                     pide escribir BORRAR para confirmar
set -euo pipefail
cd "$(dirname "$0")"
exec bash scripts/stack.sh down "${1:-}"
