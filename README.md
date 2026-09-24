# NOMFLOW

Portal web de **autogestión de empleados** y administración de Gestión Humana. Importa desde el sistema de nómina externo (mediante archivos Excel), publica los volantes de pago en PDF, y ofrece a los administradores la gestión de empresas, catálogos, empleados, cuentas, roles y auditoría.

> **Estado: pre-lanzamiento (v0.0.0).** No hay despliegue en producción. Solo se han usado datos sintéticos y archivos de muestra locales. La especificación funcional canónica es [`docs/requirements/NOMFLOW_SSD.md`](docs/requirements/NOMFLOW_SSD.md); ante cualquier diferencia, prevalece la SSD.

## Contenido

- [Qué hace hoy y qué falta](#qué-hace-hoy-y-qué-falta)
- [Arquitectura y stack](#arquitectura-y-stack)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Inicio rápido](#inicio-rápido)
- [Configuración](#configuración)
- [Cómo se cargan los datos](#cómo-se-cargan-los-datos)
- [Roles y permisos](#roles-y-permisos)
- [Interfaz web](#interfaz-web)
- [API](#api)
- [Seguridad y privacidad](#seguridad-y-privacidad)
- [Pruebas y calidad](#pruebas-y-calidad)
- [Flujo de trabajo con Git](#flujo-de-trabajo-con-git)
- [Documentación](#documentación)
- [Limitaciones y trabajo pendiente](#limitaciones-y-trabajo-pendiente)

## Qué hace hoy y qué falta

### Implementado

| Área                            | Funcionalidad                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identidad**                   | Alta administrativa de cuentas con clave temporal (Argon2id), verificación del correo por SMTP con código de un solo uso, activación, inicio y cierre de sesión, cambio de clave, bloqueo por intentos, reautenticación para acciones sensibles, bloqueo/desbloqueo y restablecimiento de clave por un administrador.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Empleados**                   | Importación de `EMPLEADOS.xlsx` con vista previa, reporte de errores y aplicación atómica; consulta, alta y corrección excepcional con motivo, historial de cambios, baja (`EST = C`, cierra sesiones) y reactivación.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Estructura organizacional**   | Empresas con logo versionado y reemplazable; CRUD e importación de áreas, centros de costo, cargos y tipos de contrato (baja lógica bloqueada si están en uso, historial de nombres); jefes de área con vigencia y sin solapes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Nómina**                      | Catálogo de conceptos con unidades (`PES`, `HRS`); importación de `NOMINA.xlsx` por período y quincena con conciliación de conteo y sumas exactas, versiones (una sola publicada, las correcciones crean una nueva); volante en PDF con logo, en modo _sin ajuste_ o _entero superior_; descarga por el propio empleado; acceso de un administrador a volantes ajenos con motivo obligatorio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Vacaciones**                  | Administración de `PROG_VAC` (períodos con `DIAS`/`DISP`, CRUD y carga Excel `N_IDE, N_CONT, PER_INI, PER_FIN, DIAS, DISP, EST` con fecha de corte, vista previa y ajustes versionados con motivo) y de festivos (borradores versionados y publicación). El empleado puede calcular fechas de disfrute y de retorno con días hábiles y festivos (`/me/vacations/preview`); el empleado envía la solicitud eligiendo uno o varios períodos y sus días hábiles (`/vacaciones`); llega al jefe de área vigente de su área (y solo a él), que aprueba, rechaza con motivo o propone cambios que el empleado debe aceptar; el aprobador final (rol `VACATION_FINAL_APPROVER`) da la aprobación final (`/aprobaciones`), que en una transacción revalida remanentes y calendario, descuenta `DISP` y crea el disfrute en `VACACIONES`. Ningún administrador firma sin el rol específico. Falta el PDF con firmas. |
| **Permisos**                    | Catálogo de tipos configurable por el administrador (`/admin/tipos-permiso`: soporte obligatorio, horas, máximo de días). El empleado solicita (`/permisos`) con justificación y soporte opcional (PDF, PNG o JPEG, 2 MB, validado por contenido); **solo lo decide el jefe de área** asignado a su área (`/aprobaciones`, pestaña Permisos): aprobar o rechazar con motivo, sin aprobación final. No descuentan vacaciones y no se cruzan con otros permisos ni con vacaciones aprobadas.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Doble paso y clave asignada** | Verificación en dos pasos **opcional** por correo: el empleado la activa en `/cuenta/seguridad` (código de 6 dígitos, 10 min, un solo uso, 5 intentos, con límite por hora) y cada ingreso pide clave + código; si el correo falla, no se abre sesión. En `/admin/empleados` (ficha, «Cuenta de acceso») el administrador ve el usuario (el correo), el estado y el doble paso, **asigna una clave** (escrita o generada, sin mostrarla ni auditarla; cierra sesiones) o crea la cuenta con clave elegida, y desactiva el doble paso por recuperación.                                                                                                                                                                                                                                                                                                                                                      |
| **Certificados de retención**   | Carga masiva: se depositan `<n_ide>_<año>.pdf` (p. ej. `840695_2025.pdf`) en la carpeta `TAX_CERT_INBOX_DIR` y el administrador pulsa «Procesar» en `/admin/retenciones`. Se valida nombre, año, PDF real, tamaño y existencia del empleado; los válidos van a `procesados/` y el resto a `rechazados/`. Una versión vigente por empleado y año (contenido distinto crea versión nueva). El empleado los ve y descarga en `/retenciones`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Administración**              | Área `/admin` solo para el perfil administrador: resumen, empresas y logo, catálogos, conceptos, empleados, cuentas y roles, importaciones con historial, nómina publicada y visor de auditoría.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Auditoría**                   | Cada petición de todos los usuarios y las actividades de negocio, consultable por administradores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Interfaz**                    | Diseño profesional con modo claro y oscuro, accesible (WCAG AA verificado), adaptable a móvil desde 320 px.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Aún no implementado (backlog, ver la SSD)

Certificados laborales firmados y certificados tributarios; exportación ZIP previa a la baja y aviso de baja; solicitudes de vacaciones y permisos con flujos de aprobación; calendario de festivos; `PROG_VAC`; segundo factor por correo en cada inicio de sesión; cola de trabajos (Redis) y almacenamiento de documentos en S3. La interfaz **no** ofrece como operativas estas funciones.

## Arquitectura y stack

Monorepo TypeScript con `npm workspaces` (decisiones en [`docs/decisions`](docs/decisions)).

```
Navegador ──► Web (Next.js 16, React 19) ──/api/*──► API (NestJS 11) ──► PostgreSQL 16
                                                           ├──► SMTP (verificación de correo)
                                                           └──► (Redis y MinIO/S3 reservados, aún sin uso)
```

- **La API es la única que autoriza.** La web habla con la API solo a través del proxy `/api` (mismo origen, sin CORS) y nunca consulta la base de datos.
- **Base de datos:** PostgreSQL con Drizzle ORM y migraciones SQL versionadas (`apps/api/migrations`). Importes con decimales exactos (`numeric`, `BigInt`; nunca `Float`).
- **Documentos:** PDF con `pdfkit`; Excel con `exceljs` (no ejecuta fórmulas ni enlaces).
- **Validación:** `zod` en cada entrada; consultas parametrizadas.
- **Herramientas:** TypeScript estricto, ESLint, Prettier, Vitest (API), Playwright + axe (interfaz), Graphify (mapa del código).

## Estructura del repositorio

```
apps/
  api/                      API NestJS
    src/
      auth/                 sesiones, CSRF, guards de rol y de reautenticación
      accounts/             alta, activación, verificación, gestión de cuentas
      employees/            CRUD de empleados con historial
      imports/              importación de EMPLEADOS y catálogos, empresas, catálogos CRUD
      payroll/              conceptos, importación de NOMINA, volantes PDF
      org/                  roles con alcance, jefes de área, logos
      admin/                resumen, historial de importaciones, auditoría, volantes ajenos
      audit/                registro de todas las peticiones
      db/                   esquema Drizzle, cliente, migrador, primer administrador
    migrations/             SQL versionado (0000 a 0014)
    assets/                 logo genérico (SVG y PNG)
  web/                      Next.js
    app/(public)/           acceso y activación
    app/(app)/              inicio, volantes, cuenta y admin/*
    components/             sistema de componentes (ui, shells, admin-ui, import-panel)
    e2e/                    pruebas de navegador (Playwright)
docs/                       SSD, decisiones, bitácoras, diseño, trazabilidad, estado
scripts/stack.sh            levanta y detiene el stack local
.github/workflows/ci.yml    integración continua
```

## Inicio rápido

**Requisitos:** Node.js 20 (`.nvmrc`), Docker con Compose y `openssl`.

```bash
npm ci
npm run stack:up        # PostgreSQL, Redis, MinIO y Mailpit en Docker; compila, migra y arranca API y web
npm run stack:status    # URLs y estado
npm run stack:down      # detiene todo (los datos se conservan)
```

`stack:up` crea un `.env` local (ignorado por Git) con un `SESSION_SECRET` aleatorio. Servicios:

| Servicio           | Dirección                                                | Notas                                                       |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| Web                | http://localhost:3000                                    | Ingreso en `/login`                                         |
| API                | http://localhost:4000/health                             |                                                             |
| Mailpit            | http://localhost:8025                                    | Bandeja de desarrollo: ningún correo sale a personas reales |
| MinIO              | consola http://localhost:9101 · S3 http://localhost:9100 | Puertos 9100/9101 para no chocar con otros proyectos        |
| PostgreSQL / Redis | localhost:5432 / localhost:6379                          | Bases `nomflow` (desarrollo) y `nomflow_test` (pruebas)     |

**Primer administrador** (con el stack en marcha):

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@nomflow.local BOOTSTRAP_ADMIN_PASSWORD="$CLAVE_INICIAL" \
  npm run admin:bootstrap -w @nomflow/api
```

`CLAVE_INICIAL` es una variable de su terminal con la clave elegida (mínimo 12 caracteres); no la escriba en archivos ni en el historial.

Después, entre en http://localhost:3000/login con ese correo, cree la empresa y cargue los archivos desde **Administración** (ver [Cómo se cargan los datos](#cómo-se-cargan-los-datos)).

Más detalles (SMTP real, puertos, Chromium en WSL) en [`docs/local-stack.md`](docs/local-stack.md).

## Configuración

Variables de entorno (plantilla en [`.env.example`](.env.example)):

| Variable                                                                                           | Descripción                                                                                      |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                                     | Conexión a PostgreSQL. Obligatoria.                                                              |
| `SESSION_SECRET`                                                                                   | Secreto de sesión y CSRF, **mínimo 32 caracteres**. Obligatorio; la API no arranca sin él.       |
| `PORT`                                                                                             | Puerto de la API (4000).                                                                         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Correo saliente. Por defecto exige TLS; en desarrollo se usa Mailpit (`SMTP_REQUIRE_TLS=false`). |
| `API_URL`                                                                                          | Destino del proxy `/api` de la web (por defecto `http://localhost:4000`); se lee al compilar.    |
| `IMPORT_MAX_BYTES`, `IMPORT_MAX_ROWS`                                                              | Límites de las importaciones (10 MB y 20 000 filas).                                             |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_ID`                          | Solo para `admin:bootstrap`.                                                                     |
| `REDIS_URL`, `S3_*`, `MINIO_*`                                                                     | Reservadas para funcionalidades futuras; hoy ningún módulo las usa.                              |
| `E2E_DATABASE_URL`, `MAILPIT_URL`                                                                  | Solo para las pruebas de navegador.                                                              |

## Cómo se cargan los datos

Todas las cargas se validan primero en un área de preparación, muestran una **vista previa con reporte de errores** y no cambian nada hasta que un administrador las **aplica**. Aplicar es atómico y repetir el mismo archivo no duplica datos.

Orden recomendado (cada paso depende del anterior):

1. **Empresa** (nombre, sigla, dirección y, opcionalmente, logo).
2. **Catálogos** por empresa: áreas, centros de costo, cargos; y tipos de contrato (globales). Un código repetido con nombres distintos detiene el lote sin elegir uno.
3. **Conceptos de nómina** con su unidad (`PES`, `HRS`).
4. **Empleados** (`EMPLEADOS.xlsx`, 24 columnas). Solo se aceptan los estados `V` (vigente) y `C` (cancelado); los códigos de empresa y catálogos deben existir. Un solo contrato vigente por persona.
5. **Cuentas**: el administrador crea la cuenta de cada empleado; se le entrega una clave temporal (se muestra una sola vez) y recibe por correo el código para activarla.
6. **Nómina** (`NOMINA.xlsx`) por período `AAAAMM` y liquidación (1 o 2): el archivo debe traer **todas** las filas de la liquidación; se concilian el conteo y las sumas exactas de devengado y deducido antes de publicar.

Los archivos Excel con datos reales **nunca** se versionan (`*.xlsx` está en `.gitignore`).

## Roles y permisos

| Rol                       | Puede                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMPLOYEE`                | Consultar y descargar sus volantes y certificados de retención; solicitar vacaciones; cambiar su clave.                                                                                                               |
| `AREA_MANAGER`            | Usuario común, con alcance de empresa y área: recibe las solicitudes de vacaciones de las personas de su área, y las aprueba, rechaza o les propone cambios.                                                          |
| `VACATION_FINAL_APPROVER` | Usuario común (no administrador) con este rol adicional, **por empresa**: ve y da la aprobación final a las solicitudes de vacaciones de su empresa, que descuenta los días. Ningún administrador firma sin este rol. |
| `CERTIFICATE_APPROVER`    | Rol registrado; su flujo aún no existe.                                                                                                                                                                               |
| `HR_ADMIN`                | Todo el área administrativa.                                                                                                                                                                                          |
| `SYSTEM_ADMIN`            | Lo mismo que `HR_ADMIN` y, además, conceder, terminar o bloquear roles y cuentas administrativas.                                                                                                                     |

Reglas transversales: nadie modifica sus propios roles ni bloquea su propia cuenta; un `HR_ADMIN` no puede escalar privilegios; todas las rutas `/admin/*` exigen `HR_ADMIN` o `SYSTEM_ADMIN`, y una prueba recorre por reflexión cada ruta para comprobarlo.

## Interfaz web

| Ruta                  | Quién           | Contenido                                                                                                               |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/login`, `/activar`  | Público         | Ingreso y activación de cuenta con el código del correo.                                                                |
| `/`                   | Autenticado     | Espacio de trabajo: tareas disponibles, datos y roles en lenguaje comprensible.                                         |
| `/volantes`           | Empleado        | Volantes en PDF, modo de presentación y filtro por año.                                                                 |
| `/cuenta/clave`       | Autenticado     | Cambio de clave.                                                                                                        |
| `/admin` y `/admin/*` | Administradores | Resumen, empresas y logo, catálogos, conceptos, empleados, cuentas y roles, importaciones, nómina publicada, auditoría. |

Diseño: tokens semánticos, modo claro y oscuro según el sistema, contraste WCAG AA, navegación por teclado con «Saltar al contenido», formularios con ayuda y errores junto a cada campo, funcionamiento desde 320 px y con texto al 200 %. Detalle, contrastes y capturas en [`docs/design/rediseno-ui.md`](docs/design/rediseno-ui.md).

## API

Todas las rutas (salvo `/health`, `/auth/login`, `/auth/activate` y `/auth/verify-email/resend`) exigen sesión, y las de escritura exigen el encabezado `X-CSRF-Token`. En los grupos marcados con ★, las operaciones sensibles (altas, cambios, bajas, cargas, aplicaciones y descarga de volantes ajenos) exigen además haber confirmado la clave en los últimos 10 minutos; la web pide la clave en un diálogo y reintenta.

| Grupo                      | Rutas principales                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticación              | `POST /auth/login` · `GET /auth/me` · `POST /auth/logout` · `POST /auth/change-password` · `POST /auth/reauth` · `POST /auth/activate` · `POST /auth/verify-email/resend`       |
| Empleado (`/me`)           | `GET /me/payroll` · `GET /me/payroll/:per/:nLiq/:contrato/pdf?mode=`                                                                                                            |
| Cuentas ★                  | `GET/POST /admin/accounts` · `POST /admin/accounts/:id/{block,unblock,reset-password}` · `GET/POST /admin/accounts/:id/roles` · `PUT /admin/accounts/:id/roles/:roleId/end`     |
| Jefes de área ★            | `POST /admin/areas/managers` · `PUT /admin/areas/managers/:id/end` · `GET /admin/areas/:cEmp/:cArea/managers`                                                                   |
| Empresas ★                 | `GET/POST /admin/companies` · `PUT /admin/companies/:id` · logo: `POST/GET /admin/companies/:id/logo`, `GET .../logos`, `POST .../logo/:logoId/activate`, `POST .../logo/reset` |
| Catálogos ★                | `GET/POST /admin/catalogs/:kind` · `PUT /admin/catalogs/:kind/:id` · `GET .../:id/history` (`AREA`, `CCOSTO`, `CARGO`, `TIPO_CONTRATO`)                                         |
| Conceptos ★                | `GET/POST /admin/payroll-concepts` · `PUT /admin/payroll-concepts/:id` · `GET .../units`                                                                                        |
| Empleados ★                | `GET/POST /admin/employees` · `GET/PUT /admin/employees/:id` · `POST .../:id/status` · `GET .../:id/history`                                                                    |
| Importaciones ★            | `POST /admin/imports/{employees,concepts,payroll,catalogs/:kind}` · `GET /admin/imports/:id` · `GET .../:id/errors` · `POST .../:id/apply` · `GET /admin/imports`               |
| Nómina y volantes ajenos ★ | `GET /admin/imports/payroll/versions` · `GET /admin/payroll/employees/:nIde/vouchers` · `GET /admin/payroll/employees/:nIde/:per/:nLiq/:contrato/pdf?mode=&reason=`             |
| Resumen y auditoría        | `GET /admin/summary` · `GET /admin/audit` (filtros por tipo, usuario, método, estado, ruta, actividad y fechas)                                                                 |

## Seguridad y privacidad

- **Claves:** Argon2id; la temporal se entrega por un canal distinto al correo y se obliga a cambiarla. Mínimo 12 caracteres.
- **Verificación del correo:** código aleatorio de 8 caracteres, guardado solo como HMAC, que vence a los 15 minutos, de un solo uso, con 5 intentos y 3 envíos por hora.
- **Sesiones:** cookie `HttpOnly` y `SameSite=Strict` (`Secure` en producción); el token se guarda solo como hash; expiran a los 30 minutos de inactividad o a las 8 horas; se cierran al bloquear o dar de baja.
- **CSRF** por HMAC en toda petición de escritura; **bloqueo** tras 5 intentos fallidos (15 minutos); mensajes que no revelan si una cuenta existe.
- **Autorización** siempre en el servidor y por propiedad: el empleado se resuelve por la sesión y ninguna URL lleva su identificación.
- **Auditoría:** registra cada petición (usuario, método, plantilla de la ruta, estado, duración, IP) y cada actividad de negocio, **sin** cuerpos, claves, códigos, tokens, salarios ni identificadores reales. Los accesos a fichas con salario y a volantes ajenos quedan registrados, estos últimos con su motivo.
- **Archivos:** Excel sin fórmulas ni enlaces, tipo verificado, límites de tamaño y filas; logos solo PNG o JPEG de hasta 512 KB.
- **Cabeceras:** `nosniff`, `X-Frame-Options: DENY` y CSP en producción.
- **Datos reales:** nunca en Git, bitácoras ni registros (`*.xlsx`, `.env` y `storage/` están ignorados; `gitleaks` corre en el CI).

## Pruebas y calidad

```bash
# Verificación obligatoria antes de cada commit (siempre contra la base de PRUEBAS)
DATABASE_URL=postgresql://nomflow:nomflow@localhost:5432/nomflow_test \
  npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit:deps

npm run test:e2e        # pruebas de navegador (Chromium); levantan su propia API y web
```

- **API: 215 pruebas** de integración contra PostgreSQL real (permisos, importaciones, concurrencia, reversión, contenido de los PDF, auditoría).
- **Interfaz: 81 pruebas de navegador** (flujos, teclado, 320 px, texto al 200 %, contraste en modo claro y oscuro con axe).
- Las pruebas **vacían las tablas**: nunca apunte `DATABASE_URL` a la base de desarrollo.
- **CI** (`.github/workflows/ci.yml`): formato, lint, tipos, build, pruebas, `npm audit`, `gitleaks`, CodeQL, mapa del código y pruebas de navegador. CodeQL sube sus resultados a Code scanning, guarda el SARIF como artefacto y falla si hay hallazgos.
- En WSL sin `sudo`, Chromium puede necesitar bibliotecas locales: ver [`docs/local-stack.md`](docs/local-stack.md).

## Flujo de trabajo con Git

Una rama por incidencia (`feat/ESS-…`, `fix/…`, `docs/…`), PR con verificación en verde y documentación actualizada (`docs/CHANGELOG.md`, `docs/traceability.md`, bitácora en `docs/sessions/`). Reglas para agentes y desarrolladores en [`CLAUDE.md`](CLAUDE.md); la SSD (secciones 10 y 11) define el protocolo de sesión, la revisión y los gates. Para estimar el impacto de un cambio: `npm run graph` y `graphify affected "<función>"` ([`docs/graphify.md`](docs/graphify.md)).

## Documentación

| Documento                                                              | Contenido                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`docs/requirements/NOMFLOW_SSD.md`](docs/requirements/NOMFLOW_SSD.md) | Especificación funcional y técnica (fuente de verdad)                                                   |
| [`docs/HANDOFF.md`](docs/HANDOFF.md)                                   | Traspaso para la próxima sesión: pendientes, orden recomendado, decisiones abiertas y trampas conocidas |
| [`docs/STATUS.md`](docs/STATUS.md)                                     | Estado actual, bloqueos y siguientes pasos                                                              |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md)                               | Cambios funcionales                                                                                     |
| [`docs/traceability.md`](docs/traceability.md)                         | Requisitos ↔ incidencias ↔ pruebas                                                                      |
| [`docs/decisions`](docs/decisions)                                     | Decisiones de arquitectura (stack, ORM)                                                                 |
| [`docs/sessions`](docs/sessions)                                       | Bitácora de cada sesión de desarrollo                                                                   |
| [`docs/design`](docs/design)                                           | Guía de diseño, rediseño de la interfaz y capturas                                                      |
| [`docs/local-stack.md`](docs/local-stack.md)                           | Entorno local y pruebas de navegador                                                                    |
| [`docs/graphify.md`](docs/graphify.md)                                 | Mapa del código y análisis de impacto                                                                   |

## Limitaciones y trabajo pendiente

Datos y operación:

- El `EMPLEADOS.xlsx` recibido trae `EST = A` en todas las filas: debe llegar una exportación con `V` o `C`.
- `CCOSTOS.xlsx` (1 código con dos descripciones) y `CARGOS.xlsx` (17 códigos) no se pueden publicar hasta corregirlos en el origen o definir una clave oficial; hay empleados que dependen de esos códigos ambiguos.
- Falta una muestra anonimizada de `NOMINA` (decimales y reversos) para probar con datos reales.
- Definir la retención de las filas de preparación de importaciones y de la auditoría de peticiones, que crece rápido.
- Habilitar STARTTLS en el servidor SMTP interno antes de producción.

Seguridad y gobierno:

- Ninguno de los PR fue revisado por otra persona y `main` no tiene protección de rama; la SSD lo exige.
- Sin segundo factor por correo en cada ingreso ni límite por IP en los endpoints públicos.

Producto: las funciones del [backlog](#aún-no-implementado-backlog-ver-la-ssd), y las mejoras de interfaz propuestas en [`docs/design/rediseno-ui.md`](docs/design/rediseno-ui.md) (sección 8).

Sin licencia pública definida: el código es de uso interno del proyecto.
