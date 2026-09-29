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
| 0.7 | Corregir las pruebas intermitentes conocidas (alta excepcional de empleados, logo en `admin.spec`, reenviar código) | Desarrollo | Prerrequisito para volver obligatorio el job e2e (1.5) |

## Fase 1 - Seguridad y resiliencia base (1 a 2 semanas)

| # | Alcance | Referencia |
| --- | --- | --- |
| 1.1 | Custodia de `OBJECT_ENCRYPTION_KEY` fuera del servidor y **rotación** con identificador de clave (`NF2\|kid`, varias claves, `storage:rotate`) | `docs/backup-clave-objetos.md`, ADR-003 |
| 1.2 | **Límite de intentos por IP** en los endpoints públicos y configuración de `trust proxy` | ESS-AUTH-001/003 |
| 1.3 | **STARTTLS** en el servidor de correo interno | Operación |
| 1.4 | **Respaldo y restauración probados** de PostgreSQL y Garage, con una restauración de ensayo documentada | ESS-OPS-001 |
| 1.5 | Protección de `main`, revisión por otra persona y job e2e obligatorio | SSD 11 |
| 1.6 | **Política de retención**: filas de preparación de importaciones (salarios), auditoría de peticiones, sesiones y códigos vencidos, PDF y ZIP | SSD 12 |

Decisiones de esta fase: plazos de retención y quién custodia la clave de objetos.

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
| 3.1 | **PDF de la constancia con las firmas** visuales de quienes aprueban (jefe, director, gerente y aprobación final) | ESS-LEAVE-003 |
| 3.2 | **Suplencias** del jefe, del director y del aprobador final | ESS-ORG-002 |
| 3.3 | Corrección de disfrutes ya registrados y reintento de la API de festivos | ESS-LEAVE-002, ESS-HOL-001 |
| 3.4 | Reglas de permisos por tipo (anticipación mínima, tope anual), consulta administrativa con motivo y PDF; decidir si la jerarquía jefe > director > gerente aplica también a permisos | ESS-PERM-001 |
| 3.5 | Códigos de `EST` y fecha de corte de `PROG_VAC`; credencial y región de la API de festivos | SSD 12 |
| 3.6 | ~~**Catálogo de turnos**: días laborales por turno, usados en el cálculo de días hábiles y fecha de retorno~~ DONE: tabla `shifts`, `/admin/turnos`, bloquea con `SHIFT_MISSING` si el empleado no tiene turno asignado o no existe en el catálogo | ESS-LEAVE-004 |

## Fase 4 - Producción

| # | Alcance | Referencia |
| --- | --- | --- |
| 4.1 | `Dockerfile` de la API y de la web, y compose de producción | ESS-OPS-001 |
| 4.2 | Despliegue, `API_URL` en tiempo de ejecución (hoy se lee al compilar) y TLS | ESS-OPS-001 |
| 4.3 | Monitoreo de CPU y memoria del servidor y alertas por otros canales | Salud del sistema |
| 4.4 | Actualizar a Node 22 antes de 2027; revisar dependencias con avisos (`exceljs`, `pdfjs-dist` fijado) | Deuda técnica |

## Fase 5 - Mejoras

- Validación pública del certificado laboral por código, sellado de tiempo y HSM.
- Segundo factor por correo en cada ingreso.
- Conmutador manual de tema, pruebas con lectores de pantalla reales y otros navegadores.
- Unificar el estilo de botones y tablas en todas las pantallas de administración.
- Correlacionar la auditoría de peticiones con los eventos de negocio (guardar `requestId`).
- Mover el logo de la base de datos al almacén de objetos.

## Mantenimiento continuo

- Al cerrar cada tarea: `docs/CHANGELOG.md`, `docs/traceability.md`, `docs/STATUS.md`, bitácora en `docs/sessions/` y `docs/HANDOFF.md`.
- Ninguna acción que borre datos reales sin aprobación previa y respaldo (regla del proyecto).
