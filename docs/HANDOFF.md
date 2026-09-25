# Traspaso para la próxima sesión

Actualizado: 24 de septiembre de 2026. Estado del código: `main` (PR #1 a #20 integrados, sin PR abiertos). Este archivo se **reescribe al cerrar cada sesión** (SSD 10.2); el historial vive en `docs/sessions/`. No contiene claves, correos ni datos de personas.

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

Identidad y cuentas, importación de EMPLEADOS, empresas y logo, catálogos, conceptos de nómina, jefes de área, importación de NOMINA y volantes PDF, área administrativa completa (API e interfaz), auditoría de todas las peticiones, rediseño de la interfaz, stack local, Graphify, CI. 215 pruebas de API y 81 de navegador.

## 3. Pendientes que esperan datos o personas (no se pueden cerrar programando)

| # | Qué falta | Responsable | Qué hacer cuando llegue |
| --- | --- | --- | --- |
| D1 | `EMPLEADOS.xlsx` con `EST` = `V`/`C` (hoy trae `A` en las 240 filas) | Gestión Humana / sistema origen | Importar desde `/admin/importaciones`; luego crear las cuentas desde `/admin/cuentas` |
| D2 | `CCOSTOS.xlsx` corregido (1 código con dos descripciones) y `CARGOS.xlsx` (17 códigos repetidos), o una **clave oficial** que los desambigüe | Gestión Humana | Importar desde `/admin/catalogos`. Si la clave es compuesta, hace falta ADR y cambiar el índice único de `catalog_entries` |
| D3 | Muestra **anonimizada** de `NOMINA` con decimales y reversos negativos | Nómina | Probar ambos modos del volante; revisar visualmente el PDF (la verificación con logo se hizo por operadores de pdfjs, no a ojo) |
| D4 | Cargar `conceptos.xlsx` (213 conceptos, unidades `PES`/`HRS`) por `/admin/conceptos` | Administrador | Sin esto los volantes muestran la cantidad sin unidad |
| D5 | Logo real de la empresa `GA` | Comunicaciones | Subirlo en `/admin/empresas` (PNG/JPEG, ≤ 512 KB) |
| D6 | Decisiones de la SSD sección 12 (ver §5) | Dueños funcionales | Registrar cada una como ADR o en la SSD |

## 4. Trabajo de desarrollo pendiente, en el orden recomendado

Cada ID está en `docs/traceability.md`. Patrón que ya funciona y conviene **reutilizar**: importación en dos pasos (vista previa → aplicar atómico, `apps/api/src/imports`), versionado con índice único parcial, historial, auditoría, reautenticación y `ADMIN_ROLES`; PDF con `pdfkit` (`apps/api/src/payroll/voucher.pdf.ts`); interfaz con `ImportPanel` y los componentes de `apps/web/components`.

| Prioridad | ID | Alcance (SSD) | Primer paso concreto |
| --- | --- | --- | --- |
| 1 | ESS-TAX-001 | **Hecho** (carga por carpeta, versiones, descarga del empleado). Queda: prueba de navegador, retención y mover el PDF a S3 | — |
| 2 | ESS-EXIT-001 | Aviso previo a la baja y ZIP con todos los documentos (3.1, 6.3) | Parámetro `PRE_BAJA_AVISO_DIAS`, cola de trabajos (Redis ya está en el stack, sin uso), manifiesto y caducidad. La baja ya revoca sesiones |
| 3 | ESS-CERT-001/002 | Plantillas de certificado con variables en lista blanca, aprobación y firma interna, código de validación público (6.1) | Pedir `CertificadoLaboral.pdf` (la SSD lo cita y **no está** en el repo) y los firmantes autorizados. Existen `CERTIFICATE_APPROVER`, reautenticación y el generador PDF |
| 4 | ESS-LEAVE-003 (resto), ESS-HOL-001 (resto) | **Hecho**: `PROG_VAC`, festivos con CRUD y publicación, cálculo, solicitud, revisiones, aprobación del jefe y final con descuento y `VACACIONES`. **Falta**: PDF con firmas visuales (imágenes de firma privadas por cuenta), suplencias del jefe, corrección/reversión de disfrutes aprobados, consulta administrativa con motivo, festivos por Excel y reintento programado de la API (la carga automática de un año sin calendario ya existe; falta el reintento periódico y la alerta al administrador) | Reutilizar `voucher.pdf.ts` para el PDF; la evidencia de firma ya se guarda en `vacation_actions` (actor, revisión, hash, fecha) |
| 5 | ESS-PERM-001 | **Hecho**: tipos configurables, solicitud con soporte y decisión solo del jefe de área. Falta: reglas adicionales por tipo si Gestión Humana las define (anticipación mínima, tope anual), consulta administrativa con motivo y PDF | — |
| 6 | ESS-OPS-001 | Endurecimiento, respaldo y restauración probados, `Dockerfile`s, despliegue, monitoreo (8, 11) | Hoy API y web corren como procesos locales; no hay imagen |
| — | Higiene | Reconciliar el estado de `docs/traceability.md` (varios ID figuran `BACKLOG` aunque ya están hechos: AUTH-001/002/003, AUD-001, IMPORT-001) | Editar la tabla con el PR que corresponda a cada uno |

Interfaz de módulos futuros (solicitudes, aprobaciones, documentos): ver `docs/design/rediseno-ui.md` §8. No mostrar nada como operativo hasta que su servicio exista.

## 5. Decisiones abiertas (SSD sección 12)

- Baja: valor inicial de `PRE_BAJA_AVISO_DIAS`, si cuenta días hábiles o calendario, canal de aviso, retención de PDF/ZIP y entrega a ex empleados.
- `PROG_VAC`: códigos de `EST`, fecha de corte y ejemplos con períodos parciales.
- Festivos: credencial de la API, región por empresa y quién aprueba diferencias.
- Certificados: firmantes y evidencia de firma.
- Operación: el SMTP se configura en `/admin/correo`; el servidor interno (192.168.1.44:25) no tiene TLS, así que los correos viajan sin cifrar dentro de la red hasta habilitar STARTTLS. Pendiente: almacenamiento, respaldos, monitoreo y suplencias.
- **Retención** de: filas de preparación de importaciones (contienen datos personales y salarios), auditoría de peticiones (crece rápido) y sesiones/códigos vencidos (nada los purga hoy).
- Gobierno: activar protección de `main`, exigir revisión de otra persona (ningún PR de la cadena #1 a #20 la tuvo). CodeQL ya es un control real: sube a Code scanning (pestaña Security), guarda el SARIF y falla por hallazgos. Con el repositorio público quedaron activos el escaneo de secretos con protección de push y las alertas de Dependabot.

## 6. Deuda técnica y de seguridad conocida

- Sin segundo factor por correo en cada ingreso ni límite por IP en los endpoints públicos; `req.ip` requiere configurar `trust proxy` detrás de un proxy.
- La auditoría de peticiones se escribe de forma asíncrona (si la base falla solo queda un aviso) y no se correlaciona con los eventos de negocio (solo por usuario y hora; el `requestId` no se guarda en los eventos).
- El cambio de correo de un empleado con cuenta exige una «resolución administrativa» que no está implementada; una importación posterior sobrescribe las correcciones manuales (`source = MANUAL` → `IMPORT`).
- Jefes de área: faltan las **suplencias** que pide la SSD.
- El logo se guarda en la base de datos; los documentos futuros deberían ir a S3.
- `API_URL` de la web se lee al **compilar** (rewrites de Next).
- El job `e2e` del CI es informativo; volverlo obligatorio cuando se estabilice (CodeQL ya lo es).
- Interfaz: sin conmutador manual de tema, sin lectores de pantalla reales ni otros navegadores, las tablas administrativas son regiones desplazables, el menú móvil no atrapa el foco.
- Graphify: solo extracción por código; la semántica con LLM está prohibida sin aprobación (envía contenido a un tercero).

## 7. Estado del entorno local (no versionado)

- Contenedores Docker `nomflow-*` con datos en volúmenes: base `nomflow` (desarrollo) y `nomflow_test` (pruebas y e2e).
- Base de desarrollo: empresa `GA` registrada, catálogos `AREA` y `TIPO_CONTRATO` cargados, sin `CCOSTO`, `CARGO`, conceptos ni empleados reales, y un par de cuentas de prueba. **Las claves no se registran aquí**: recrear un administrador con `BOOTSTRAP_ADMIN_EMAIL=… BOOTSTRAP_ADMIN_PASSWORD="$CLAVE" npm run admin:bootstrap -w @nomflow/api`.
- Archivos Excel de origen en la raíz del repositorio: ignorados por Git; **no subirlos**.
- Puertos: web 3000, API 4000, Mailpit 8025, Garage S3 3900 y admin 3903. Las pruebas e2e usan 3100 y 4100.

## 8. Trampas conocidas (ya costaron tiempo)

- **Salud del sistema**: el ciclo de verificación corre dentro de la API (cada `checkIntervalMin`, primera a los 30 s); se desactiva con `HEALTH_MONITOR=off` (las pruebas e2e lo hacen) y no corre en `NODE_ENV=test`. Sin `GARAGE_ADMIN_TOKEN` el espacio se reporta como aviso «no se pudo medir». Si el correo no está configurado, las alertas solo quedan en pantalla e historial.

1. **Las pruebas vacían las tablas.** Nunca apuntar `DATABASE_URL` a `nomflow`.
2. Ejecutar `npx prettier --write .` antes de `format:check`: los metadatos de migraciones generados no cumplen el formato. Prettier también reajusta líneas y rompe reemplazos automáticos de texto.
3. Drizzle: dentro de una subconsulta escrita con `sql`, las columnas de la tabla externa salen sin calificar y se comparan consigo mismas. Usar alias explícitos.
4. Playwright: `getByLabel` coincide por subcadena también con `aria-label` de regiones (usar `exact: true`); el anunciador de rutas de Next es un `role="alert"` vacío (usar `p[role="alert"]`); al fallar una prueba el proceso se reinicia y se pierde el estado del módulo (`nextPeriod()` consulta la base por eso); ExcelJS incrusta la fecha, así que dos exportaciones del mismo contenido difieren.
5. Chromium en WSL sin `sudo`: bajar `libnspr4`, `libnss3` y `libasound2t64` con `apt-get download`, extraer con `dpkg -x` y exportar `LD_LIBRARY_PATH` (ver `docs/local-stack.md`).
6. GitHub: `gh pr edit` falla por Projects (classic); cambiar la base con `gh api -X PATCH repos/OWNER/REPO/pulls/N -f base=main`. Los PR apilados se integran en orden con **merge commit** (no squash) y casi siempre chocan en `docs/CHANGELOG.md` (archivo de solo añadir): conservar ambas líneas.
7. gitleaks marca ejemplos como falsos positivos: resolver con la huella en `.gitleaksignore` (`commit:archivo:regla:línea`) o, si es un patrón, con `.gitleaks.toml`; nunca desactivando el job.
8. `pdfjs-dist` está fijado en `5.5.207` (solo pruebas) porque las versiones ≥ 5.6.83 y < 6.2.108 tienen una vulnerabilidad alta. `exceljs` arrastra un aviso moderado de `uuid`.
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

## 9. Cierre de una tarea (definición de terminado)

Criterios de aceptación cumplidos, pruebas para los riesgos reales, la verificación de §1 en verde, PR integrado, `docs/CHANGELOG.md`, `docs/traceability.md`, `docs/STATUS.md` y una bitácora nueva en `docs/sessions/`, y **este archivo actualizado**.
