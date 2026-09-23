# Changelog

## Unreleased
- Documentación inicial: SSD canónica, STATUS, ADR-001 (stack) y matriz de trazabilidad.
- Monorepo npm workspaces: apps/api (NestJS 11, /health), apps/web (Next 16), CI (format, lint, tipos, build, tests, audit, gitleaks, CodeQL), docker-compose de desarrollo.
- Esquema inicial (Drizzle): cuentas, asignaciones de rol y auditoría; hash Argon2id de claves; pruebas de integración con PostgreSQL.
- Alta administrativa de cuentas (servicio): exige HR_ADMIN vigente, EST=V con contrato único, correo normalizado, clave temporal Argon2id y auditoría. Tabla employee_snapshots.
- Login y sesiones: POST /auth/login, GET /auth/me, POST /auth/logout; cookie HttpOnly SameSite=Strict, token de sesión hasheado, CSRF (HMAC) en métodos no seguros, bloqueo tras 5 intentos (15 min), expiración por inactividad (30 min) y absoluta (8 h), revocación por cuenta. Requiere SESSION_SECRET.
