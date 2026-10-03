# Plan de trabajo por fases

Actualizado: 26 de septiembre de 2026. Estado de partida: `main` con los PR #1 a #76 integrados (ver [STATUS](STATUS.md)). Cada fase se cierra con la verificación de `CLAUDE.md`, el PR integrado y los documentos de estado al día. Los pendientes que solo dependen de datos o de personas están en la fase 0 y en las decisiones de cada fase.

## Criterio de prioridad

1. Lo que **bloquea el uso real** hoy (datos por cargar, roles sin asignar).
2. Lo que protege **datos y accesos** antes de abrir el sistema a más personas.
3. Lo que **cierra un ciclo de la especificación** (baja, vacaciones, permisos).
4. Lo que lleva el sistema a **producción**.
5. Mejoras.

## Fase 0 - Puesta en marcha con datos reales (esta semana; sin desarrollo grande)

| # | Pendiente | Responsable | Notas |
| --- | --- | --- | --- |
| 0.1 | Cargar `nomina.xlsx` en la base real (4.991 filas, 580 liquidaciones) | Administrador | Respaldo `pg_dump` antes; revisar en la vista previa: 580 liquidaciones y 10 volantes con más de un `SLRIO` |
| 0.2 | Asignar el **director de cada área** y el **gerente general** (Catálogos > Áreas > «Jefe y director»; Cuentas > Roles) | Gestión Humana | Sin ellos, las solicitudes de vacaciones de los jefes (y de los directores) se rechazan con «sin jefe vigente». Reemplazar los 29 jefes de prueba |
| 0.3 | Definir quién aprueba las vacaciones de quien ocupa la **aprobación final** (hoy se bloquearían por la regla de autoaprobación) | Gestión Humana | Decisión de negocio; puede requerir un segundo aprobador final |
| 0.4 | Que el Director Financiero y el Gerente General carguen su firma; confirmar ciudad, pie y código de formato del certificado laboral | Firmantes / Gestión Humana | Solo la Directora de Gestión Humana tiene firma |
| 0.5 | Cargar `PROG_VAC` real desde `/admin/vacaciones` | Gestión Humana | |
| 0.6 | Primera prueba real del archivo histórico: «Enviar al histórico» en `/admin/archivo` y en `/admin/registros` contra el bucket | Administrador | Lo probado hasta ahora fue con almacenes simulados |
| 0.7 | ~~Corregir las pruebas intermitentes conocidas~~ DONE (30 de septiembre de 2026): suite completa de navegador en verde (125). «Reenviar código» esperaba 5 s a un envío SMTP (ahora 20 s); los menús de administrador y empleado y las dos pruebas de vacaciones estaban desactualizadas tras los PR de turnos y de baja. «Alta excepcional» y «logo» no se reprodujeron en 50 repeticiones | Desarrollo | Desbloquea el job e2e obligatorio (1.5); requiere Garage, PostgreSQL y Mailpit activos |

## Fase 1 - Seguridad y resiliencia base (1 a 2 semanas)

| # | Alcance | Referencia |
| --- | --- | --- |
| 1.1 | Custodia de `OBJECT_ENCRYPTION_KEY` fuera del servidor y **rotación** con identificador de clave (`NF2\|kid`, varias claves, `storage:rotate`) | `docs/backup-clave-objetos.md`, ADR-003 |
| 1.2 | ~~**Límite de intentos por IP** en los endpoints públicos y configuración de `trust proxy`~~ DONE: `AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS` (20 cada 15 min por omisión) en login, login/verify, activate y verify-email/resend; `TRUST_PROXY` para leer `X-Forwarded-For` detrás de un proxy reverso | ESS-AUTH-001/003 |
| 1.3 | **STARTTLS** en el servidor de correo interno | Operación |
| 1.4 | **Respaldo y restauración probados** de PostgreSQL y Garage, con una restauración de ensayo documentada | ESS-OPS-001 |
| 1.5 | Protección de `main`, revisión por otra persona y job e2e obligatorio | SSD 11 |
| 1.6 | ~~**Política de retención**: filas de preparación de importaciones (salarios), auditoría de peticiones, sesiones y códigos vencidos, PDF y ZIP~~ DONE: plazos configurables y depuración manual o diaria de sesiones, códigos, filas de importación y ZIP caducados (`/admin/retencion`); la auditoría de peticiones conserva su política en Registros (365 días); los certificados de retención nunca se purgan solos, solo borrado manual de personas dadas de baja | SSD 12 |

Decisiones de esta fase: quién custodia la clave de objetos.

## Fase 2 - Ciclo de vida del empleado

| # | Alcance | Referencia |
| --- | --- | --- |
| 2.1 | ~~**Aviso previo a la baja** (`PRE_BAJA_AVISO_DIAS`), cola de trabajos y bloqueo al pasar a `EST = C`~~ DONE: `PRE_BAJA_AVISO_DIAS` configurable (15 días calendario por omisión), programación manual de la baja por N_IDE, job periódico en proceso (sin Redis) que envía el aviso y registra incumplimiento si `EST = C` llega sin aviso previo | ESS-EXIT-001 |
| 2.2 | ~~**ZIP** con todos los volantes, certificados tributarios y constancias del empleado, con manifiesto y caducidad~~ DONE: exportación asíncrona (job en proceso), manifiesto con reporte de faltantes, ZIP cifrado en el almacén de objetos, caducidad de 7 días, descarga auditada | ESS-EXIT-001 |
| 2.3 | ~~**Retiro de publicación** de una versión de nómina, con motivo y auditoría~~ DONE: `POST admin/imports/payroll/versions/:id/retire`, con motivo obligatorio, cambia el estado a `RETIRADA` sin borrar la versión, auditado | ESS-PAY-001 |
| 2.4 | ~~Cambio de correo de un empleado con cuenta mediante resolución administrativa; que una importación no pise correcciones manuales~~ DONE: `POST admin/employees/:id/email-resolution` cambia el correo, exige nueva verificación (`PENDIENTE_VERIFICACION`) y revoca sesiones; la importación conserva un correo corregido manualmente (`source = MANUAL`) y avisa en el reporte del lote | ESS-EMP-002 |

Decisiones de esta fase: valor inicial de `PRE_BAJA_AVISO_DIAS`, si cuenta días hábiles o calendario, canal del aviso y entrega a ex empleados.

## Fase 3 - Completar vacaciones y permisos

| # | Alcance | Referencia |
| --- | --- | --- |
| 3.1 | ~~**PDF de la constancia con las firmas** visuales de quienes aprueban (jefe, director, gerente y aprobación final)~~ DONE: cada aprobador carga su firma en Mi cuenta → Mi firma de aprobación (`/me/approver-signature`, con autorización propia, distinta de la de certificados); la constancia lleva la firma del primer aprobador (con su cargo: jefe, director o gerente) y de la aprobación final, o dice «Firma en imagen no registrada» | ESS-LEAVE-003 |
| 3.2 | ~~**Suplencias** del jefe, del director y del aprobador final~~ DONE: el titular designa a su suplente en Mi cuenta → Mis suplencias (rango obligatorio, hasta 90 días, sin fechas pasadas, sin cadenas ni cruces); el suplente debe tener un rol que apruebe en la misma empresa; mientras dura, solo el suplente decide lo que le toca al titular (pendiente y nuevo, vacaciones y permisos); el titular puede terminarla y Gestión Humana anularla con motivo; la constancia dice «En suplencia de X» | ESS-ORG-002 |
| 3.3 | ~~Corrección de disfrutes ya registrados y reintento de la API de festivos~~ DONE: Gestión Humana anula un disfrute aprobado (Administración → Disfrutes aprobados) con motivo, hasta el último día del disfrute; los días hábiles aún no disfrutados vuelven a PROG_VAC (a la versión vigente del período; los ya disfrutados se conservan descontados, del período más antiguo primero, y quien anula elige si cuentan hasta ayer —por omisión— o hasta hoy), la solicitud queda ANULADA y la constancia deja de entregarse. Para cambiar fechas se anula y se solicita de nuevo (no hay edición de un disfrute aprobado). Festivos: el último intento de cada año se guarda en la base y Festivos → Calendarios por año muestra el año actual, el siguiente y los que fallaron, con «Cargar ahora» manual; no se agregaron reintentos automáticos | ESS-LEAVE-002, ESS-HOL-001 |
| 3.4 | Reglas de permisos por tipo (anticipación mínima, tope anual), consulta administrativa con motivo y PDF; decidir si la jerarquía jefe > director > gerente aplica también a permisos | ESS-PERM-001 |
| 3.5 | Códigos de `EST` y fecha de corte de `PROG_VAC`; credencial y región de la API de festivos | SSD 12 |
| 3.6 | ~~**Catálogo de turnos**: días laborales por turno, usados en el cálculo de días hábiles y fecha de retorno~~ DONE: tabla `shifts`, `/admin/turnos`, bloquea con `SHIFT_MISSING` si el empleado no tiene turno asignado o no existe en el catálogo | ESS-LEAVE-004 |
| 3.7 | ~~Solicitud de vacaciones atada a un jefe que ya no es el del área~~ DONE: Administración → Solicitudes pendientes lista las solicitudes en espera del primer visto bueno, quién las tiene y quién es hoy el aprobador, y Gestión Humana las reasigna (`POST /admin/vacations/:id/reassign`, queda en el historial y en la auditoría). | ESS-LEAVE-005 |

## Fase 4 - Producción

| # | Alcance | Referencia |
| --- | --- | --- |
| 4.1 | `Dockerfile` de la API y de la web, y compose de producción | ESS-OPS-001 |
| 4.2 | Despliegue, `API_URL` en tiempo de ejecución (hoy se lee al compilar) y TLS | ESS-OPS-001 |
| 4.3 | Monitoreo de CPU y memoria del servidor y alertas por otros canales | Salud del sistema |
| 4.4 | Actualizar a Node 22 antes de 2027; revisar dependencias con avisos (`exceljs`, `pdfjs-dist` fijado) | Deuda técnica |

## Fase 5 - Mejoras

- Validación pública del certificado laboral por código, sellado de tiempo y HSM.
- ~~Segundo factor por correo en cada ingreso~~: ya existe y lo activa cada persona en Mi cuenta → Verificación en dos pasos (`/me/two-factor`). Además de la app autenticadora TOTP con QR (PR #99). Pendiente solo si se quisiera hacerlo obligatorio por rol y aceptar el TOTP en los actos de firma (reautenticación).
- ~~Conmutador manual de tema~~ DONE (Mi cuenta → Apariencia, se guarda en el navegador). Las pruebas con lectores de pantalla son ahora automáticas (árbol de accesibilidad y axe); falta la revisión manual con NVDA, JAWS, VoiceOver u Orca y probar otros navegadores.
- Unificar el estilo de botones y tablas en todas las pantallas de administración.
- Correlacionar la auditoría de peticiones con los eventos de negocio (guardar `requestId`).
- Mover el logo de la base de datos al almacén de objetos.

## Mantenimiento continuo

- Al cerrar cada tarea: `docs/CHANGELOG.md`, `docs/traceability.md`, `docs/STATUS.md`, bitácora en `docs/sessions/` y `docs/HANDOFF.md`.
- Ninguna acción que borre datos reales sin aprobación previa y respaldo (regla del proyecto).
