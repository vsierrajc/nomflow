# Traspaso para la próxima sesión

Actualizado: 3 de octubre de 2026. Estado del código: `main` (PR hasta el #111 integrados; no hay PR abiertos). El usuario revisó y aprobó la integración de los PR #97-#109; #110 (documentación) y #111 (arreglo de la interfaz) se integraron sin una revisión registrada. Este archivo se **reescribe al cerrar cada sesión** (SSD 10.2); el historial vive en `docs/sessions/`. No contiene claves, correos ni datos de personas. **El plan por fases está en [PLAN.md](PLAN.md).**

## 1. Cómo arrancar (10 minutos)

```bash
git switch main && git pull --ff-only origin main && git status --short   # árbol limpio
npm ci
npm run stack:up          # PostgreSQL, Redis, Garage (S3), Mailpit + API y web (crea .env local la primera vez)
npm run graph             # mapa del código (docs/graphify.md)
```

Leer, en este orden: `CLAUDE.md` → este archivo → `docs/STATUS.md` → última bitácora en `docs/sessions/` → SSD (`docs/requirements/NOMFLOW_SSD.md`, secciones 6, 9, 10, 11 y 12). Trabajar siempre en una rama por incidencia (`feat/ESS-…`).

Verificación obligatoria antes de cada commit (**siempre contra la base de pruebas**):

```bash
npx prettier --write .    # primero: incluye los metadatos de migraciones generados
DATABASE_URL=postgresql://nomflow:nomflow@localhost:5432/nomflow_test \
  npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit:deps
npm run test:e2e          # pruebas de navegador (ver docs/local-stack.md si Chromium no arranca en WSL)
```

## 2. Qué está hecho (resumen; detalle en README y STATUS)

Identidad y cuentas (clave asignada, doble paso opcional, sesión por inactividad), importación de EMPLEADOS, empresas, logo y encabezado/pie en imagen, catálogos, conceptos de nómina, roles con alcance (jefe y director de área, gerente general), importación de NOMINA por período y liquidación del archivo, volantes PDF en carta según el modelo, certificados de retención (carpeta y navegador), certificado laboral con firma imagen y digital, vacaciones con aprobación jerárquica, permisos, bandeja de entrada y avisos por correo, salud del sistema, almacenamiento cifrado en Garage, archivo histórico en Google, gestión de registros, área administrativa completa, rediseño de la interfaz, stack local, Graphify y CI. 400 pruebas de API y unas 115 de navegador.

## 2.0 Integrado: ESS-RET-001 (retención de datos, #91)

`feat/ESS-RET-politica-retencion`: política de retención de sesiones, códigos, filas de importación y ZIP caducados (`apps/api/src/registros/data-retention*`, página `/admin/retencion`). Los certificados de retención nunca se purgan solos: solo borrado manual tras la baja. Antes de activar `auto_enabled` con datos reales: `pg_dump` y aprobación. Detalle en `docs/sessions/2026-09-30-politica-retencion.md`.

## 2.0c Integrado: revisión del flujo de vacaciones (#102 a #109)

Detalle y decisiones en `docs/sessions/2026-10-03-vacaciones.md`. Lo que conviene saber al tocar vacaciones:

- **Fecha inicial**: una solicitud nueva (y la propuesta del jefe) no puede empezar antes de hoy (`START_IN_PAST`); `VACATION_ALLOW_PAST_START=true` lo permite. La aprobación final no la aplica. Las pruebas de API fijan la variable en `vitest.config.ts` porque usan fechas fijas de 2026.
- **Constancia**: si el jefe propuso cambios, su acto sobre la revisión aprobada es `PROPONER` (no hay `APROBAR_JEFE`) y es el que firma.
- **Solicitudes atadas a un jefe que ya no es el del área**: Administración → Solicitudes pendientes (`/admin/solicitudes-pendientes`) las lista y las reasigna.
- **Anular un disfrute**: `enjoyedUntil` (`YESTERDAY` por omisión, `TODAY`) fija hasta cuándo cuentan como disfrutados los días de un disfrute en curso; solo vuelven los no disfrutados (lógica en `leave/annul-plan.ts`, la misma para la vista previa y la anulación). Queda registrado en `vacaciones` (`dias_devueltos`, `dias_disfrutados`, `disfrutados_hasta`) y el empleado recibe aviso.
- **Contrato vigente**: ni el jefe ni la aprobación final aprueban a quien ya no tiene `EST = V` (422 `NO_ACTIVE_CONTRACT`); rechazar sigue permitido.
- **Ciclo automático**: al vencer el período más antiguo por el tope de 3 queda un ajuste del sistema (`prog_vac_adjustments.actor_account_id` nulo).
- **Migraciones**: `0038_totp`, `0039_anular_disfrute_festivos`, `0040_ajuste_del_sistema`, `0041_anular_dias_no_disfrutados`.

## 2.0b Integrado: ESS-AUTH-003 (app autenticadora TOTP, #99)

[PR #99](https://github.com/vsierrajc/nomflow/pull/99). Servicio en `apps/api/src/auth/totp.service.ts`, pantallas en `apps/web/components/totp-setup.tsx` y `/cuenta/seguridad`. La migración es `0038_totp`; `0039_anular_disfrute_festivos` (#101) va después. Rotar `SESSION_SECRET`/`SETTINGS_ENCRYPTION_KEY` deja ilegibles los secretos TOTP (documentado en README). Pendiente a futuro: exigir TOTP por rol (administradores y aprobadores) y aceptarlo en los actos de firma (reautenticación). Detalle en `docs/sessions/2026-10-02-totp.md`.

## 2.1 Integrado: ESS-EXIT-001 (aviso de baja y ZIP, #85)

[PR #85](https://github.com/vsierrajc/nomflow/pull/85). Backend completo en `apps/api/src/exit/` (settings, programación de baja, aviso por correo, exportación ZIP asíncrona vía job en proceso sin Redis, incumplimiento auditado si `EST = C` llega sin aviso previo, endpoints "revisar/generar ahora" para no depender del temporizador) y web en `apps/web/app/(app)/admin/bajas` y `apps/web/app/(app)/mi-baja`. Probado con `apps/api/src/exit/exit.e2e.spec.ts` (6 casos) y `apps/web/e2e/bajas.spec.ts` + `apps/web/e2e/mi-baja.spec.ts` (7 casos de navegador, que encontraron y corrigieron dos errores reales: `e.currentTarget` nulo tras un `await`, y un código HTTP de cancelar inconsistente entre backend y frontend). Verificación obligatoria completa en verde (422 pruebas de API). Integrado en #85. Detalle en `docs/sessions/2026-09-29-aviso-baja-zip.md` y `docs/sessions/2026-09-29-aviso-baja-zip-2.md`.

## 3. Pendientes que esperan datos o personas (fase 0 del plan)

Ver [PLAN.md](PLAN.md), fase 0: cargar `nomina.xlsx` y `PROG_VAC` reales (con respaldo previo y aprobación), asignar el director de cada área y el gerente general, firmas de los firmantes, ciudad/pie/código del certificado laboral, y la primera prueba real del archivo histórico. **Todo lo que escribe datos reales exige aprobación explícita del usuario y un `pg_dump` previo.**

## 4. Trabajo de desarrollo pendiente

Está ordenado por prioridad y por fases en [PLAN.md](PLAN.md): seguridad y resiliencia (fase 1), ciclo de vida del empleado y ZIP (fase 2), completar vacaciones y permisos (fase 3), producción (fase 4) y mejoras (fase 5). Patrón que conviene **reutilizar**: importación en dos pasos (vista previa y aplicación atómica, `apps/api/src/imports`), versionado con índice único parcial, historial, auditoría y `ADMIN_ROLES`; PDF con `pdfkit` (`apps/api/src/payroll/voucher.pdf.ts`, `apps/api/src/certificates/labor-cert.pdf.ts`); tareas periódicas dentro de la API (salud, avisos, registros).

Higiene: la matriz `docs/traceability.md` se actualizó el 3 de octubre de 2026; mantenerla con cada PR.

## 5. Decisiones abiertas (SSD sección 12)

- Baja: valor inicial de `PRE_BAJA_AVISO_DIAS`, si cuenta días hábiles o calendario, canal de aviso, retención de PDF/ZIP y entrega a ex empleados.
- `PROG_VAC`: códigos de `EST`, fecha de corte y ejemplos con períodos parciales.
- Festivos: credencial de la API, región por empresa y quién aprueba diferencias.
- Certificados: evidencia de firma y confirmación de ciudad, pie y código de formato.
- Vacaciones: quién aprueba las de quien ocupa la aprobación final; si la jerarquía jefe > director > gerente aplica también a permisos.
- Operación: STARTTLS del correo interno, almacenamiento, respaldos, monitoreo y suplencias.
- Plazos definitivos de retención y su activación automática en producción.
- Gobierno: activar la protección de `main` y exigir revisión de otra persona. CodeQL ya es un control real y con el repositorio público están activos el escaneo de secretos y Code scanning.

## 6. Deuda técnica y de seguridad conocida

- **Clave de objetos (`OBJECT_ENCRYPTION_KEY`)**: sin copia fuera del servidor los certificados y constancias guardados no se recuperan. Falta que una persona la custodie (ver `docs/backup-clave-objetos.md`) y la rotación con identificador de clave (`NF2|kid`, varias claves, `storage:rotate`), aplazada por decisión del usuario.
- `req.ip` requiere configurar `trust proxy` detrás de un proxy (el límite por IP y el doble paso opcional por correo ya existen).
- La auditoría de peticiones se escribe de forma asíncrona (si la base falla solo queda un aviso) y no se correlaciona con los eventos de negocio (solo por usuario y hora; el `requestId` no se guarda en los eventos).
- El cambio de correo de un empleado con cuenta exige una «resolución administrativa» que no está implementada; una importación posterior sobrescribe las correcciones manuales (`source = MANUAL` → `IMPORT`).
- Suplencias: el suplente hereda por completo lo del titular (vacaciones y permisos) y el titular queda sin acción durante el rango; si el suplente es quien pidió una solicitud asignada al titular, esa solicitud espera al regreso del titular (no puede aprobarse a sí mismo).
- El logo se guarda en la base de datos; los documentos futuros deberían ir a S3.
- `API_URL` de la web se lee al **compilar** (rewrites de Next).
- El job `e2e` del CI es informativo; volverlo obligatorio cuando se estabilice (CodeQL ya lo es).
- Interfaz: el conmutador de tema existe (Mi cuenta → Apariencia, guardado en el navegador); falta la revisión manual con lectores de pantalla reales y otros navegadores, las tablas administrativas son regiones desplazables, el menú móvil no atrapa el foco.
- **Aviso `node-forge` (GHSA-86w9-cpqp-85rv)**: `npm run audit:deps` ahora corre `scripts/audit-deps.mjs`, que acepta ese aviso **hasta el 1 de noviembre de 2026** (no hay versión corregida; arreglo abierto en digitalbazaar/forge#1152; NOMFLOW no usa la verificación RSA de forge). Al vencer el CI falla a propósito: revisar si ya existe `node-forge` corregido (actualizar y quitar la excepción) o renovar la fecha con justificación. Si el aviso se vuelve explotable aquí, reemplazar `node-forge` (ver `certificates/digital-signature.ts`).
- Graphify: solo extracción por código; la semántica con LLM está prohibida sin aprobación (envía contenido a un tercero).

## 7. Estado del entorno local (no versionado)

- Contenedores Docker `nomflow-*` con datos en volúmenes con nombre: base `nomflow` (desarrollo, con datos reales cargados desde `initconfigdata`) y `nomflow_test` (pruebas y e2e). **Las claves no se registran aquí.** Nunca usar `docker volume prune` ni `system prune`.
- `initconfigdata/` (Excel de origen y `volante_pago.pdf`, el modelo del volante con datos reales) está ignorado por Git: **no subirlo**. `nomina.xlsx` está allí y aún no se cargó en la base real.
- Respaldos manuales en `~/nomflow-respaldos` (fuera del repositorio).
- Puertos: web 3000, API 4000, Mailpit 8025, Garage S3 3900 y admin 3903. Las pruebas e2e usan 3100 y 4100.

## 8. Trampas conocidas (ya costaron tiempo)

- **Salud del sistema**: el ciclo de verificación corre dentro de la API (cada `checkIntervalMin`, primera a los 30 s); se desactiva con `HEALTH_MONITOR=off` (las pruebas e2e lo hacen) y no corre en `NODE_ENV=test`. Sin `GARAGE_ADMIN_TOKEN` el espacio se reporta como aviso «no se pudo medir». Si el correo no está configurado, las alertas solo quedan en pantalla e historial.

1. **Las pruebas vacían las tablas.** Nunca apuntar `DATABASE_URL` a `nomflow`.
2. Ejecutar `npx prettier --write .` antes de `format:check`: los metadatos de migraciones generados no cumplen el formato. Prettier también reajusta líneas y rompe reemplazos automáticos de texto.
3. Drizzle: dentro de una subconsulta escrita con `sql`, las columnas de la tabla externa salen sin calificar y se comparan consigo mismas. Usar alias explícitos.
4. Playwright: `getByLabel` coincide por subcadena también con `aria-label` de regiones (usar `exact: true`); el anunciador de rutas de Next es un `role="alert"` vacío (usar `p[role="alert"]`); al fallar una prueba el proceso se reinicia y se pierde el estado del módulo (`nextPeriod()` consulta la base por eso); ExcelJS incrusta la fecha, así que dos exportaciones del mismo contenido difieren.
5. Chromium en WSL sin `sudo`: bajar `libnspr4`, `libnss3` y `libasound2t64` con `apt-get download`, extraer con `dpkg -x` y exportar `LD_LIBRARY_PATH` (ver `docs/local-stack.md`).
6. GitHub: `gh pr edit` falla por Projects (classic); cambiar la base con `gh api -X PATCH repos/OWNER/REPO/pulls/N -f base=main`. Los PR apilados se integran en orden con **merge commit** (no squash).
7. gitleaks marca ejemplos como falsos positivos: resolver con la huella en `.gitleaksignore` (`commit:archivo:regla:línea`) o, si es un patrón, con `.gitleaks.toml`; nunca desactivando el job.
8. `pdfjs-dist` (solo pruebas) va en `^6.4.299`: las versiones ≥ 5.6.83 y < 6.2.108 tienen una vulnerabilidad alta, así que no bajar de 6.2.108. `exceljs` (4.4.0, sin mantenimiento) arrastra un aviso moderado de `uuid`, cubierto por el `overrides` de `package.json`, y paquetes deprecados internos (`fstream`, `glob` 7, `inflight`, `rimraf` 2, `lodash.isequal`) que no se arreglan actualizando; quedan hasta reemplazar `exceljs`. `drizzle-kit` trae `@esbuild-kit/*` deprecados (del propio paquete). `npm audit` solo marca `node-forge` (excepción vigente).
9. `pkill -f` puede matar el propio shell si el patrón aparece en la orden; usar los archivos PID de `.run/` (`scripts/stack.sh`).
10. Usar `@node-rs/argon2` (binarios precompilados); `argon2` necesita compilar y aquí falta `make`.
11. **`overrides` de npm**: con un lockfile existente npm no re-resuelve versiones ya satisfechas; hay que regenerar el lockfile (`rm -rf package-lock.json node_modules && npm install`) y usar la forma anidada (`"exceljs": {"uuid": "11.1.1"}`) o versiones exactas. Dependabot solo actualiza dependencias **directas**; las transitivas (uuid por exceljs, esbuild por drizzle-kit) se fijan con `overrides`. No exportar `LD_LIBRARY_PATH` de Chromium al correr las pruebas de API: rompe `@napi-rs/canvas`.
12. **Pruebas de navegador y cierre de sesión**: `Cerrar sesión` es asíncrono (pide `/auth/logout` y luego redirige a `/login`). Una prueba que abra `/login` sin esperar `toHaveURL(/\/login$/)` compite con esa redirección y falla de forma intermitente (fue la causa de `acceso.spec` «cambio de clave»).
13. **Pruebas que se repiten sobre la misma base**: la base `nomflow_test` persiste entre ejecuciones locales. Una prueba que elija un año o dependa de una tabla de fila única (`holiday_api_settings`) debe elegir un dato libre o partir de cero; verificar con `--repeat-each`.
14. **Migraciones aún no integradas**: si regeneras una migración que ya se aplicó en `nomflow_test`, la base de pruebas queda con la versión vieja (`CREATE TABLE` falla por «ya existe»). Solucionar quitando la tabla y su fila de `drizzle.__drizzle_migrations` en la base de pruebas (solo esa base).
15. **Falsos positivos de CodeQL**: una alerta descartada por la API se pierde si el código cambia de línea. Las decisiones ya revisadas (cookie de sesión) van como comentario `// codeql[regla]` con su justificación junto al código.
16. **Pruebas de navegador**: tras pulsar «Ingresar» hay que esperar la URL `/` antes de navegar; abrir otra página antes interrumpe el ingreso y falla de forma intermitente. Un aviso que ya estaba en pantalla no sirve para esperar una acción repetida: esperar el estado real.
17. **`docker compose down` y los volúmenes**: PostgreSQL debe tener un volumen con nombre (`pgdata`). Con uno anónimo, `down` deja los datos huérfanos y `up` crea una base vacía. Y `npm run build` con la aplicación en marcha rompe las páginas («This page couldn't load»): reiniciar con `./iniciar_app.sh`.
18. Integrar PR sin revisión de otra persona lo bloquea el clasificador de permisos salvo instrucción explícita del usuario y regla de permisos.

- **Firma digital de certificados laborales**: los `.p12` de los firmantes se guardan cifrados con `SETTINGS_ENCRYPTION_KEY` (o `SESSION_SECRET`); cambiar esa clave los deja inservibles. `@signpdf/placeholder-plain` NO se usa (arrastra un pdfkit antiguo con `crypto-js` vulnerable): el espacio de firma lo reserva `apps/api/src/certificates/digital-signature.ts`. El campo `/Contents` lleva relleno de ceros: se recorta por el largo del DER, nunca quitando ceros del final.

- **Registros**: `.gitignore` excluye directorios llamados `logs/` (por eso el módulo se llama `registros`). Vaciar `.run/*.log` solo es seguro porque `stack.sh` los abre con `>>`; los archivos gestionables se declaran en `LOG_FILES`. Las peticiones HTTP también se auditan, así que cualquier consulta añade filas: las pruebas cuentan solo lo que siembran.
- **Variables de entorno entre comandos**: cada llamada de shell empieza sin `DATABASE_URL`; exportarla en la misma línea que las pruebas (`export DATABASE_URL=... && npm test`) o las pruebas de base de datos se omiten en silencio (aparecen como «skipped»).
- **`docs/CHANGELOG.md` ya no se edita por PR**: cada cambio añade un archivo en `docs/changelog.d/` (ver su README) y de vez en cuando se corre `npm run changelog:compile` en un commit aparte. Si aun así aparece un conflicto en `CHANGELOG.md` (rama vieja, o alguien lo editó a mano), resolver quitando las marcas de conflicto y conservando ambas líneas.
- **Carga de nómina**: el período y la liquidación salen de las columnas `PER` y `N_LIQ`; cada volante del archivo reemplaza al publicado y los demás de la liquidación se conservan. Un contenido idéntico se detecta al aplicar, no al validar.

- **Node 22**: el proyecto exige Node 22 (`.nvmrc`, `engines`). Con otra versión `npm install` solo avisa, pero las pruebas y el CI se corren con 22: en WSL, `nvm install` y `nvm use` en la raíz del repositorio. Tras cambiar de Node, reinstalar con `npm ci`; las primeras pruebas de navegador después de reinstalar pueden fallar por el arranque en frío, y se repiten.
- **Fechas de negocio**: «hoy» y las vigencias (roles, asignaciones, suplencias, calendarios, nombres de archivo) se cuentan por el día de Colombia con `todayBogota()` / `dateBogota()` de `apps/api/src/common/dates.ts` (web: `lib/dates.ts`). Nunca `new Date().toISOString().slice(0, 10)`: es UTC y desde las 19:00 locales ya es mañana (un rol que vence hoy se daba por vencido cinco horas antes). **Lo mismo en las pruebas**: calcular «hoy» con `todayBogota()` / `addDays(...)` (API) o `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' })` (navegador), nunca con `toISOString()`: el CI corre de día en Colombia y no lo nota, pero de 19:00 a 24:00 esas pruebas fallan. Las pruebas con fecha simulada usan `vi.useFakeTimers({ toFake: ['Date'] })` (ver `auth/fecha-colombia.e2e.spec.ts`).
- **Listas que dependen de otra selección** (empresa → áreas, centros de costo, cargos): la petición se hace en un `useEffect` y la respuesta de la selección anterior puede llegar después de la nueva y pisarla. Cada efecto debe descartar la respuesta vieja (`let stale = false` y devolver `() => { stale = true }`); ver `admin/empleados` y `admin/cuentas`. Esto era la causa de la prueba intermitente de `admin-gestion.spec.ts`.
- **Copilot y las ramas de PR**: el agente de Copilot puede subir commits a la rama de un PR (pasó en #106: un arreglo de `admin-gestion.spec.ts`). El CI de un commit del bot queda en `action_required` hasta que alguien lo apruebe, así que el PR se queda sin checks. Antes de integrar, comprobar que la cabeza del PR es el commit propio (`gh pr view --json commits`).
- **Pruebas de navegador en un worktree**: Playwright lee las credenciales de Garage del `.env` de la raíz; un worktree nuevo no lo tiene y fallan retenciones, certificado laboral y constancias (503). Copiar el `.env` (está ignorado). En WSL exportar también `LD_LIBRARY_PATH` (ver `docs/local-stack.md`).

## 9. Cierre de una tarea (definición de terminado)

Criterios de aceptación cumplidos, pruebas para los riesgos reales, la verificación de §1 en verde, PR integrado, un fragmento en `docs/changelog.d/`, `docs/traceability.md`, `docs/STATUS.md` y una bitácora nueva en `docs/sessions/`, y **este archivo actualizado**.
