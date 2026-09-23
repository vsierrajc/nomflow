# Changelog

## Unreleased
- Documentación inicial: SSD canónica, STATUS, ADR-001 (stack) y matriz de trazabilidad.
- Monorepo npm workspaces: apps/api (NestJS 11, /health), apps/web (Next 16), CI (format, lint, tipos, build, tests, audit, gitleaks, CodeQL), docker-compose de desarrollo.
- Esquema inicial (Drizzle): cuentas, asignaciones de rol y auditoría; hash Argon2id de claves; pruebas de integración con PostgreSQL.
- Alta administrativa de cuentas (servicio): exige HR_ADMIN vigente, EST=V con contrato único, correo normalizado, clave temporal Argon2id y auditoría. Tabla employee_snapshots.
- Login y sesiones: POST /auth/login, GET /auth/me, POST /auth/logout; cookie HttpOnly SameSite=Strict, token de sesión hasheado, CSRF (HMAC) en métodos no seguros, bloqueo tras 5 intentos (15 min), expiración por inactividad (30 min) y absoluta (8 h), revocación por cuenta. Requiere SESSION_SECRET.
- Verificación por SMTP y activación: código aleatorio de un solo uso (8 caracteres, HMAC, 15 min, 5 intentos, máx. 3 envíos/hora) enviado al correo de EMPLEADOS; POST /auth/activate (clave temporal + código + clave nueva ≥12) y POST /auth/verify-email/resend; nodemailer con TLS exigido por defecto; Mailpit en docker-compose.
- Endpoint POST /admin/accounts (sesión + rol HR_ADMIN vigente + reautenticación en los últimos 10 min); POST /auth/reauth; guards Roles/RecentAuth; los administradores (HR_ADMIN/SYSTEM_ADMIN) pueden iniciar sesión sin contrato EST=V; comando `npm run admin:bootstrap` para crear el primer administrador.
- Importación de EMPLEADOS (.xlsx): POST /admin/imports/employees (staging, validación de encabezados, tipos, EST V/C, unicidad, un contrato vigente), GET /admin/imports/:id y /errors, POST /admin/imports/:id/apply (transacción con bloqueo, conteo verificado, conciliación por N_IDE+N_CONT, EST=C revoca sesiones). employee_snapshots con las 24 columnas de EMPLEADOS.
- Empresas y catálogos organizacionales: CRUD de empresas con control de versión (GET/POST/PUT /admin/companies); importación Excel de AREA, CCOSTO, CARGO y TIPO_CONTRATO (POST /admin/imports/catalogs/:kind, misma vista previa/aplicación atómica), historial de cambios de nombre, listado GET /admin/imports/catalogs/:kind; EMPLEADOS se valida contra empresa y catálogos publicados (código inexistente = error, descripción distinta = advertencia).
