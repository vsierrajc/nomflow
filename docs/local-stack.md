# Stack local de desarrollo

```bash
npm run stack:up       # PostgreSQL, Redis, MinIO y Mailpit en Docker + API y web locales
npm run stack:status   # URLs y estado
npm run stack:down     # detiene API, web y los contenedores (los datos se conservan)
```

| Servicio | URL / puerto | Notas |
| --- | --- | --- |
| Web (Next.js) | http://localhost:3000 | Aún sin pantallas de usuario |
| API (NestJS) | http://localhost:4000/health | Login, cuentas, importaciones, catálogos, roles |
| Mailpit | http://localhost:8025 (SMTP 1025) | Bandeja de desarrollo: ningún correo sale a empleados reales |
| MinIO | consola http://localhost:9101, S3 http://localhost:9100 | Puertos 9100/9101 para no chocar con otros proyectos en 9000/9001 |
| PostgreSQL | localhost:5432 | Bases `nomflow` (desarrollo) y `nomflow_test` (pruebas) |
| Redis | localhost:6379 | Aún sin uso (cola de trabajos pendiente) |

## Notas
- `stack:up` crea `.env` (ignorado por git) desde `.env.example` con un `SESSION_SECRET` aleatorio, compila, migra y arranca los procesos; los registros quedan en `.run/*.log`.
- Para usar el SMTP real de la red interna, editar `SMTP_HOST`, `SMTP_PORT` y `SMTP_REQUIRE_TLS` en `.env` y repetir `stack:up`.
- Primer administrador: `BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... npm run admin:bootstrap -w @nomflow/api`.
- Las pruebas vacían las tablas: correrlas siempre con `DATABASE_URL=postgresql://nomflow:nomflow@localhost:5432/nomflow_test`.
- Redis, MinIO y la web todavía no los usa ninguna funcionalidad: se levantan para tener el stack completo de la SSD (sección 2).

## Pruebas de interfaz (Playwright)
```bash
npm run test:e2e
```
Levantan solas una API en el puerto 4100 sobre `nomflow_test` y una web en el 3100 (compilada aparte en `.next-e2e`), por lo que **no tocan** los datos de desarrollo ni los puertos 3000/4000. Requieren PostgreSQL y Mailpit activos (`npm run stack:up`); el código de activación se lee de Mailpit.

- Primera vez: `cd apps/web && npx playwright install chromium`.
- En WSL sin `sudo`, si Chromium no arranca por bibliotecas faltantes (`libnspr4`, `libnss3`, `libasound2`), descargar los `.deb` con `apt-get download`, extraerlos con `dpkg -x` en `~/.cache/nomflow-libs/root` y exportar `LD_LIBRARY_PATH=$HOME/.cache/nomflow-libs/root/usr/lib/x86_64-linux-gnu`.
- El job `e2e` del CI es informativo (`continue-on-error`) y sube las trazas si falla.
