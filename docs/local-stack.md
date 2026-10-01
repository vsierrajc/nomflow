# Stack local de desarrollo

```bash
npm run stack:up       # PostgreSQL, Redis, Garage y Mailpit en Docker + API y web locales
npm run stack:status   # URLs y estado
npm run stack:down     # detiene API, web y los contenedores (los datos se conservan)
```

| Servicio | URL / puerto | Notas |
| --- | --- | --- |
| Web (Next.js) | http://localhost:3000 | Aún sin pantallas de usuario |
| API (NestJS) | http://localhost:4000/health | Login, cuentas, importaciones, catálogos, roles |
| Mailpit | http://localhost:8025 (SMTP 1025) | Bandeja de desarrollo: ningún correo sale a empleados reales |
| Garage | S3 http://localhost:3900, admin http://localhost:3903 | Bucket `nomflow-private` (`scripts/garage-init.sh`, idempotente) |
| PostgreSQL | localhost:5432 | Bases `nomflow` (desarrollo) y `nomflow_test` (pruebas) |
| Redis | localhost:6379 | Aún sin uso (cola de trabajos pendiente) |

## Notas
- `stack:up` crea `.env` (ignorado por git) desde `.env.example` con un `SESSION_SECRET` aleatorio, compila, migra y arranca los procesos; los registros quedan en `.run/*.log`.
- Para usar el SMTP real de la red interna, lo más simple es configurarlo desde la aplicación: `/admin/correo` (servidor `192.168.1.44`, puerto `25`, sin TLS, sin usuario ni clave, correo de origen `nomflow@gr4l.co`). También puede hacerse con `SMTP_HOST`, `SMTP_PORT` y `SMTP_REQUIRE_TLS` en `.env` (respaldo cuando nada se guardó en la pantalla).
- Primer administrador: `BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... npm run admin:bootstrap -w @nomflow/api`.
- Las pruebas vacían las tablas: correrlas siempre con `DATABASE_URL=postgresql://nomflow:nomflow@localhost:5432/nomflow_test`.
- Redis todavía no lo usa ninguna funcionalidad: se levantan para tener el stack completo de la SSD (sección 2).

## Pruebas de interfaz (Playwright)
```bash
npm run test:e2e
```
Son 57 pruebas (acceso, volantes y el área administrativa completa: empresas y logo, catálogos, conceptos, empleados, cuentas y roles, importaciones, auditoría, reautenticación y accesibilidad). Levantan solas una API en el puerto 4100 sobre `nomflow_test` y una web en el 3100 (compilada aparte en `.next-e2e`), por lo que **no tocan** los datos de desarrollo ni los puertos 3000/4000. Requieren PostgreSQL y Mailpit activos (`npm run stack:up`); el código de activación se lee de Mailpit.

- Primera vez: `cd apps/web && npx playwright install chromium`.
- En WSL sin `sudo`, si Chromium no arranca por bibliotecas faltantes (`libnspr4`, `libnss3`, `libasound2`), descargar los `.deb` con `apt-get download`, extraerlos con `dpkg -x` en `~/.cache/nomflow-libs/root` y exportar `LD_LIBRARY_PATH=$HOME/.cache/nomflow-libs/root/usr/lib/x86_64-linux-gnu`.
- El job `e2e` del CI es informativo (`continue-on-error`) y sube las trazas si falla.

## Iniciar y detener

```bash
./iniciar_app.sh                  # levanta Docker, compila, migra y arranca API y web
./detener_app.sh                  # para API y web y ejecuta `docker compose down` (conserva los datos)
./detener_app.sh --borrar-datos   # además borra los volúmenes; exige escribir BORRAR
```

Son envoltorios de `scripts/stack.sh` (`npm run stack:up|down|status`). Los datos de PostgreSQL viven en el volumen con nombre `nomflow_pgdata` y los de Garage en `nomflow_garage-meta` y `nomflow_garage-data`; sobreviven a `down`. Antes de que existiera `nomflow_pgdata`, PostgreSQL usaba un volumen anónimo que **se perdía de vista** al eliminar el contenedor (los datos quedaban huérfanos en un volumen sin nombre): si eso pasó, se recuperan copiando ese volumen a `nomflow_pgdata`.

No ejecute `npm run build` mientras la aplicación está en marcha: sustituye los archivos que la web está sirviendo y las páginas fallan con «This page couldn't load» hasta reiniciarla con `./iniciar_app.sh`.

## Arranque automático al abrir WSL

Cuando se desarrolla en WSL, un reinicio de WSL (o de Windows) detiene Docker y, con él, PostgreSQL, Redis, Garage, Mailpit, la API y la web: el login muestra «No se pudo conectar con el servidor». Para que vuelvan solos al abrir WSL se usa un servicio de usuario de systemd. **Es configuración del equipo de cada persona, no del repositorio**: no se versiona ni cambia el código.

Requisitos: systemd activo en WSL (`/etc/wsl.conf` con `[boot]` y `systemd=true`) y Docker habilitado al arranque (`systemctl is-enabled docker`).

Qué hace y qué no:

- Levanta los contenedores (`docker compose up -d`, que conserva los volúmenes) y luego la API y la web **ya compiladas**, con los mismos `.run/*.pid` y `.run/*.log` de `scripts/stack.sh`; por eso `./iniciar_app.sh` y `./detener_app.sh` siguen funcionando.
- **No compila ni migra.** Tras cambiar de rama, o cuando una rama trae migraciones, hay que ejecutar `./iniciar_app.sh` una vez (con respaldo `pg_dump` previo si se toca la base con datos reales). Si falta compilar, el servicio se detiene y lo dice en el registro.
- Solo arranca cuando WSL arranca: si se reinicia Windows y no se abre WSL, la aplicación no sube hasta abrirlo.

### Instalación

1. Guardar el script en `~/.local/bin/nomflow-arranque.sh` (ajustar la ruta del repositorio en `cd`) y darle permiso de ejecución (`chmod +x`):

```bash
#!/usr/bin/env bash
# Arranque automático de NOMFLOW al abrir WSL. No compila ni migra (eso lo hace ./iniciar_app.sh):
# levanta los contenedores y, si ya están compilados, la API y la web con los mismos .run/*.pid.
set -euo pipefail
cd /home/juank/nomflow
RUN=.run; mkdir -p "$RUN"
API_PORT="${API_PORT:-4000}"; WEB_PORT="${WEB_PORT:-3000}"

for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "Docker no responde" >&2; exit 1; }

docker compose up -d postgres redis garage mailpit
for _ in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U nomflow >/dev/null 2>&1 && break
  sleep 1
done

[ -f apps/api/dist/main.js ] && [ -d apps/web/.next ] \
  || { echo "Falta compilar: ejecute ./iniciar_app.sh una vez" >&2; exit 1; }

set -a; . ./.env; set +a
alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
start() { # nombre, comando...
  local n="$1"; shift
  alive "$n" && { echo "$n ya estaba en ejecución"; return; }
  setsid nohup "$@" >>"$RUN/$n.log" 2>&1 </dev/null &
  echo $! >"$RUN/$n.pid"
}
LOG_FILES="api=$PWD/$RUN/api.log,web=$PWD/$RUN/web.log" PORT="$API_PORT" start api node apps/api/dist/main.js
start web npm run start -w @nomflow/web -- -p "$WEB_PORT"
for u in "http://localhost:$API_PORT/health" "http://localhost:$WEB_PORT"; do
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "$u" && break; sleep 1; done
done
echo "NOMFLOW en ejecución"
```

2. Guardar la unidad en `~/.config/systemd/user/nomflow.service`:

```ini
[Unit]
Description=NOMFLOW (contenedores, API y web) al abrir WSL

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=%h/.local/bin/nomflow-arranque.sh
KillMode=process
TimeoutStartSec=300

[Install]
WantedBy=default.target
```

3. Activarla y permitir que arranque sin iniciar sesión:

```bash
systemctl --user daemon-reload
systemctl --user enable nomflow.service
loginctl enable-linger "$USER"
```

### Comprobar, probar y desactivar

```bash
systemctl --user status nomflow.service        # estado
journalctl --user -u nomflow.service -n 30     # qué hizo la última vez
systemctl --user start nomflow.service         # arrancar ahora (equivale a un arranque de WSL)
systemctl --user disable nomflow.service       # desactivar el arranque automático
```

Para una prueba real: `wsl --shutdown` desde PowerShell, abrir WSL de nuevo y esperar un minuto; `curl localhost:4000/health` debe responder `{"status":"ok"}`.
