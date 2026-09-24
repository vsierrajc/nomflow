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
