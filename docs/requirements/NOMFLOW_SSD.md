# NOMFLOW — Especificación de desarrollo seguro (SSD)

**Estado:** especificación funcional y técnica en revisión. **Alcance inicial:** autoservicio de empleados vigentes, importación Excel, estructura organizacional, volantes PDF, certificados laborales firmados, certificados tributarios PDF, solicitudes de permisos y vacaciones, exportación ZIP previa a la baja y administración CRUD. Las decisiones abiertas de la sección 12 deben cerrarse antes de declarar completa cada funcionalidad afectada.

## 1. Propósito y fuentes de verdad

NOMFLOW utiliza `EMPLEADOS` y `V_NOMINA` del sistema externo como fuente de datos laborales y liquidaciones. El administrador mantiene estructura organizacional y períodos `PROG_VAC`; los disfrutes aprobados se registran en `VACACIONES`. El portal guarda cuentas, solicitudes, revisiones, aprobaciones, firmas, documentos y auditoría. Las importaciones preservan versiones de origen. Los empleados solo consultan lo propio; el administrador autorizado puede consultar todo con auditoría y motivo.

El desarrollo sigue identificación de amenazas, diseño de controles, implementación revisada y verificación continua. Cada requisito se vincula a incidencia, PR y criterios de aceptación mediante la sección 10. Este documento define el comportamiento requerido; los detalles de implementación quedan en migraciones, contratos API, ADR y pruebas versionadas en el repositorio.

## 2. Arquitectura de referencia

Repositorio TypeScript con aplicación web, API, base de datos relacional, cola de trabajos para importaciones/PDF/ZIP y almacenamiento privado de documentos. Una opción inicial es Next.js, NestJS, PostgreSQL, Redis y almacenamiento compatible con S3. Fijar versiones compatibles en el repositorio y lockfiles al iniciar el proyecto; cambios de componentes requieren ADR y pruebas. La API es la única responsable de autorización y de resolver el `N_IDE` desde la sesión. La aplicación web nunca consulta directamente la base de datos de nómina ni el almacén privado.

Módulos: identidad/cuentas; organización y CRUD; importaciones; nómina/volantes; vacaciones/permisos; certificados y firmas; documentos/ZIP; notificaciones; auditoría. Los datos importados no sustituyen los hechos históricos ya emitidos. Los contratos de cada módulo deben definir DTO, permisos, errores, paginación y eventos auditables antes de implementar endpoints.

## 3. Seguridad y privacidad

### 3.1 Identidad y autorización

- **Cuenta local:** el usuario es un correo electrónico verificado que procede de `EMPLEADOS.EMAIL` asociado a `N_IDE`. En `EMPLEADOS.xlsx` hay 240 personas/contratos/correos únicos, pero todas las celdas `EST` contienen `A` por error de la muestra. La regla confirmada del sistema es `EST = V` para vigente y `EST = C` para cancelado. La carga valida esos valores; `A` se rechaza y requiere una exportación corregida antes de activar cuentas. Se exige además unicidad del correo por persona y un solo contrato vigente.
- **Alta administrativa:** el administrador crea la cuenta, vincula el `N_IDE` al `EMAIL` importado de `EMPLEADOS` y comprueba `EST = V` antes de asignar una clave temporal. La clave se almacena únicamente como hash Argon2id; se entrega por un canal separado y se obliga a cambiarla en el primer acceso. El administrador no puede leer una clave ya guardada. La cuenta queda `PENDIENTE_VERIFICACION` hasta completar el paso de correo; un correo duplicado o no asociado al `N_IDE` impide crearla.
- **Verificación de identidad por buzón:** NOMFLOW genera un secreto aleatorio de un solo uso, envía su representación al `EMAIL` del empleado por SMTP y almacena **solo su hash**. El empleado devuelve el valor recibido a la aplicación; el servidor compara su hash, exige coincidencia con cuenta/`N_IDE`, expiración, límite de intentos y uso único. No enviar el digest almacenado como si fuera contraseña permanente. Esta verificación acredita control del buzón registrado, por lo que la exactitud de la relación `EMAIL`–`N_IDE` en el origen es un requisito operativo.
- **Acceso:** después de verificar el buzón y cambiar la clave temporal, se inicia sesión con correo y contraseña; se puede solicitar de nuevo un código al correo en cada inicio como segundo paso. Reenvíos y recuperación limitados, sesiones revocables. Aprobadores, administradores y actos de firma requieren reautenticación. Cookies seguras `HttpOnly`, protección CSRF y expiración.
- **Baja:** el administrador configura `PRE_BAJA_AVISO_DIAS` (entero no negativo) y programa la notificación y disponibilidad del ZIP con esa anticipación respecto de la fecha prevista de cancelación; el cambio del parámetro se audita. La unidad del plazo (calendario o hábil) y su valor inicial se validan con Gestión Humana. Al aplicar `EST = C`, revocar inmediatamente sesiones y enlaces del empleado, incluso si el origen anticipó la baja sin aviso; registrar la incidencia y tramitar entrega externa con identidad verificada. El administrador autorizado conserva acceso auditado sin reactivar la cuenta.
- **Permisos:** múltiples roles con alcance de empresa/área y vigencia. En cada operación comprobar rol, alcance y propiedad por `N_IDE`; ninguna ID suministrada por el cliente sustituye la identidad de sesión. Firmar requiere el rol específico vigente, incluso para administradores.

### 3.2 Controles técnicos

Usar consultas parametrizadas (incluidas consultas SQL inevitables), validación de DTO y tipos, escape de contenido al generar HTML/PDF, CSP, protección CSRF, controles de acceso por objeto y TLS. Cifrar y restringir documentos, respaldos y datos sensibles según clasificación; gestionar claves y secretos fuera del código. Registrar eventos sin contraseñas, códigos, tokens, salario ni identificación completa en logs técnicos. Aplicar límites de tamaño y análisis de archivos importados, retención, restauración probada y pruebas de autorización. Un hash o QR de un documento no equivale a firma digital criptográfica.

## 4. Convenciones de datos

`N_IDE` identifica a la persona; `N_CONT` identifica un contrato y solo uno puede estar vigente por persona. `PER` de nómina es `AAAAMM`; `N_LIQ` es 1 o 2. `SLRIO` es salario histórico de liquidación, `S_ACT` salario actual del empleado. El período programado de vacaciones (`PROG_VAC.PER_INI`, `PER_FIN`) usa **fechas** y es independiente de `PER` de nómina. `DIAS`/`DISP` y los días asignados a períodos son hábiles; `VACACIONES.DIAS_DIS` mide días calendario según las fechas de disfrute y no se descuenta directamente de `DISP`. `HLIQ` de `EMPLEADOS` es informativo (indica liquidación cada 15 días): es opcional, se conserva tal cual y no interviene en cálculos ni validaciones; la quincena efectiva de un volante la define `N_LIQ`. Los importes y cantidades usan decimales exactos. Los identificadores se preservan como texto. La fuente de cada dato y su versión se conservan en documentos emitidos.

## 5. Modelo de dominio canónico de NOMFLOW

Esta sección es el modelo canónico; la elección de ORM y migraciones se fija en ADR-001 y ADR-002. Las migraciones concretas se derivarán de este modelo una vez confirmadas las decisiones pendientes; no se debe usar ningún esquema genérico previo. PostgreSQL almacena datos sincronizados, cuentas, flujos y documentos; el sistema externo mantiene la autoridad sobre empleados y liquidaciones.

| Entidad | Identidad y contenido mínimo | Reglas |
| --- | --- | --- |
| `Account` | ID, `N_IDE`, correo normalizado, hash de clave temporal/definitiva, estado de verificación y sesiones | Alta y clave temporal por administrador; activación por secreto enviado por SMTP al correo de `EMPLEADOS`; obligar cambio de clave inicial. Bloquear si `EST = C`. |
| `Company` | `C_EMP`, nombre legal, sigla, dirección, logo, identificación y datos de contacto/configuración documental | Estructura organizacional y membretes/reportes; logo privado/versionado y uso por empresa. |
| `AREA` / `AreaManagerAssignment` | `C_EMP`, `C_AREA`, `AREA`; jefe `manager_account_id`, vigencia desde/hasta | `AREAS.xlsx` aporta `C_ARE`/`NOMAREA`, mapeados a `C_AREA`/`AREA`. La tabla `AREA` vincula cada área a una cuenta de usuario con rol `AREA_MANAGER` (aprobador de área), con vigencia e historial. El administrador mantiene esa vinculación; no basta un nombre o la columna `JEFE_AREA` vacía del Excel. |
| `CostCenter` | `C_EMP`, `C_COS`, `NOMCOSTOS` | Catálogo `CCOSTOS` asociado a la empresa y al empleado. |
| `JobPosition` | `C_EMP`, `C_CAR`, `NOMCAR` | Catálogo `CARGOS` asociado a la empresa y al empleado; la clave `(C_EMP, C_CAR)` debe corresponder a una descripción inequívoca en la versión publicada. |
| `ContractType` | `TIPO_CONTRATO` (código de texto), `NOMCONTRATO`, versión y vigencia | Catálogo de tipos contractuales. El contrato del empleado debe referenciar un código válido, preservando ceros iniciales; la descripción se toma del catálogo publicado. |
| `EmployeeSnapshot` | Versión/importación, `N_IDE`, `N_CONT`, `EMAIL`, `C_AREA`, `AREA`, `EST`, `TIPO_CONTRATO` y restantes campos de `EMPLEADOS` | El esquema de `EMPLEADOS.xlsx` es el esquema confirmado de la tabla. La muestra trae 240 identidades y códigos contractuales válidos; `EST = A` en todas las filas es un error del archivo y se corrige a `V` desde el origen antes de publicarla. Solo `V` habilita acceso; `C` lo revoca. |
| `RoleAssignment` | Cuenta, rol, alcance de empresa/área y vigencia | Roles `EMPLOYEE`, `AREA_MANAGER`, `VACATION_FINAL_APPROVER`, `CERTIFICATE_APPROVER`, `HR_ADMIN`, `SYSTEM_ADMIN`. Una cuenta puede tener varios roles. |
| `ImportBatch`, `PayrollVersion`, `PayrollLine` | Alcance, hashes, controles, `PER`, `N_LIQ`, `N_IDE`, `CONTRATO`, líneas y versión publicada | Importación atómica e idempotente. Importes `Decimal`, nunca `Float`; `SLRIO` histórico. |
| `PROG_VAC` | `N_IDE`, `N_CONT`, `PER_INI`, `PER_FIN`, `DIAS`, `DISP`, `EST`, fecha de corte y versión | Programa/período vacacional importado y mantenido por CRUD; `DISP` son días hábiles disponibles. `LIQUIDADA` es estado interno cuando `DISP = 0`; no inferir el significado de `EST` externo sin catálogo. |
| `VacationRequest`, `VacationRequestAllocation`, `VacationRevision`, `VACACIONES`, `ApprovalAction` | Uno o varios `PROG_VAC` con días hábiles asignados; `VACACIONES.FEC_INI_DIS`, `FEC_FIN_DIS`, `DIAS_DIS` calendario, fecha de retorno, revisiones y firmas | Cada aprobación crea un registro de disfrute `VACACIONES` y asignaciones por programa; no sobrescribe los períodos ni otros disfrutes. |
| `HolidayCalendar` | Empresa, región, año, fecha festiva, origen (`API`/`MANUAL`/`EXCEL`), estado de publicación y versión | Sincronización de la API y administración local; cobertura del intervalo y retorno, incluido cambio de año. |
| `PermitRequest` y acciones | Tipo, fechas/horas, justificación, soporte y flujo | Catálogo y reglas de permisos configurables; no asumir saldo vacacional para permisos. |
| `CertificateTemplate`, `CertificateRequest`, `CertificateIssuance` | Texto versionado, snapshot, aprobador, firma, PDF y código de validación | Certificado laboral del contrato vigente al solicitarlo. No modificar documento emitido. |
| `TaxCertificate` | `N_IDE`, año fiscal, versión, PDF, hash, lote/operador y estado | Un documento publicado por persona/año; reemplazos versionados y auditados. No generar el contenido fiscal desde nómina. |
| `DocumentExport` | Solicitante, empleado objeto, instante, selección, manifiesto, ZIP, hash, caducidad | Propietario activo antes de baja o administrador autorizado en cualquier momento; motivo y auditoría obligatorios para acceso administrativo. |
| `AuditLog` | Actor, acción, recurso, resultado, fecha, contexto mínimo | Sin contraseñas, códigos de un solo uso, salarios o documentos completos en logs. |

Índices y restricciones de unicidad deben respetar versiones y vigencia, en particular un solo contrato activo por `N_IDE`, un solo correo verificado asignado a cuenta activa, y una versión publicada por alcance de nómina. No eliminar en cascada volantes, certificados emitidos ni auditoría al desactivar una cuenta. La retención y disposición se definirán con los responsables funcionales antes del despliegue.


## 6. Flujos funcionales

### 6.1 Emisión de certificados laborales

> **Decisión del 2026-09-25 (ADR-005):** el certificado laboral se emite en autoservicio, sin aprobador ni firma; el contenido está en plantillas editables y cada documento lleva el código del formato de calidad. Lo que sigue describe el flujo con aprobación y firma, que queda como mejora futura.

El certificado laboral usa la última instantánea validada de `EMPLEADOS` (sección 9). La cuenta está vinculada a `N_IDE`; el empleado no puede suministrar otra identificación para obtener certificados ajenos.

1. El empleado solicita el certificado. La API autentica la sesión, resuelve `N_IDE`, exige `EST = V` y selecciona el único contrato vigente. Los contratos anteriores no se presentan como relación laboral vigente.
2. Se leen `NOMBRE`, `N_IDE`, `F_INI`, `N_CONT`, `TIPO_CONTRATO` del origen, códigos `C_CAR`/`C_COS`/`C_AREA` y descripciones de los catálogos (`NOMCONTRATO`, `NOMCAR`, `NOMCOSTOS`, `NOMAREA`). `EMPLEADOS.xlsx` exporta códigos `TIPO_CONTRATO` válidos `01`–`05` en las 240 filas; la plantilla presenta `NOMCONTRATO` del código verificado del contrato vigente. `S_ACT` se incluye solo en la variante con salario. Es el salario **actual**, no el de una liquidación anterior; `F_INI` corresponde al inicio de ese contrato.
3. Se selecciona una versión aprobada de `CertificateTemplate`, se sustituyen variables permitidas y se presenta la vista previa al usuario con rol `CERTIFICATE_APPROVER`. Membrete, razón social, identificación de empresa, ciudad, datos del firmante y verificación se configuran por separado.
4. El aprobador revisa, rechaza con motivo o aprueba y firma el PDF final según 6.1.2. El empleado solo descarga la versión emitida, nunca un borrador presentado como firmado.
5. La emisión guarda código de validación único y no predecible, persona/contrato, versiones de datos y plantilla, firmante, evidencia, momento y SHA-256 del PDF. El verificador público acepta el código (opcionalmente en QR), limita intentos y devuelve solo validez y metadatos no sensibles; no expone salario, documento completo ni PDF. El código permite detectar documentos sin una emisión registrada, pero por sí solo no impide copiar o editar un PDF; para comprobar los bytes se contrasta hash o firma criptográfica cuando se implemente.
6. Se auditan solicitudes, decisiones, firmas y descargas. Un cambio posterior de `EMPLEADOS` no altera certificados ya expedidos; una nueva solicitud genera una emisión nueva.

#### 6.1.1 Plantillas de texto almacenadas en base de datos

El contenido editable del certificado reside en una tabla `CertificateTemplate`, no en cadenas fijas del código. Campos mínimos: `id`, `company_id`, `code` (por ejemplo `LABORAL_SIN_SALARIO` o `LABORAL_CON_SALARIO`), `version`, `title`, `body_template`, `locale`, `status` (`DRAFT`, `APPROVED`, `RETIRED`), `effective_from`, `created_by`, `approved_by`, `created_at`, `approved_at` y `content_hash`. Debe existir como máximo una versión aprobada vigente por empresa, código y fecha. Editar una versión aprobada crea una versión nueva; las anteriores se conservan para auditoría. Un administrador autorizado edita y previsualiza con datos ficticios; un segundo responsable aprueba la publicación según la política interna.

Ejemplo de `body_template` para la variante sin salario:

> `{{EMPRESA_NOMBRE}} certifica que {{NOMBRE}}, identificado(a) con el documento No. {{N_IDE}}, se encuentra vinculado(a) mediante el contrato No. {{N_CONT}} desde el {{F_INI}}, desempeñando el cargo de {{CARGO}} en el centro de costo {{CCOSTO}}. Se expide en {{CIUDAD_EMISION}} el {{FECHA_EMISION}}.`

La redacción sobre vinculación **solo** se habilita cuando `EST = V` para el contrato y existe un único contrato vigente. La emisión para ex empleados está fuera del autoservicio inicial; si se requiere, seguirá el procedimiento administrativo externo, sin inventar fecha de retiro que `EMPLEADOS` no suministra. El ejemplo es texto configurable, sujeto a aprobación del área responsable.

| Variable permitida | Fuente / formato |
| --- | --- |
| `{{N_IDE}}`, `{{NOMBRE}}`, `{{N_CONT}}` | `EMPLEADOS.N_IDE`, `NOMBRE`, `N_CONT` del contrato seleccionado |
| `{{F_INI}}` | `EMPLEADOS.F_INI`, formateada como fecha en español |
| `{{C_CAR}}`, `{{CARGO}}`, `{{C_COS}}`, `{{CCOSTO}}`, `{{C_AREA}}`, `{{AREA}}` | Códigos `C_CAR`, `C_COS`, `C_AREA` de `EMPLEADOS`; las descripciones se verifican con `CARGOS.CARGO`, `CCOSTOS.CCOSTO` y `AREA.NOMAREA` (catálogo `C_ARE` mapeado a `C_AREA`). |
| `{{TIPO_CONTRATO}}` | `NOMCONTRATO` del catálogo, resuelto mediante código `TIPO_CONTRATO` verificado para el contrato vigente; usar variante aprobada sin esta cláusula si falta |
| `{{S_ACT}}` | Salario actual de `EMPLEADOS`, formateado como moneda; solo en variante con salario y con autorización |
| `{{EMPRESA_NOMBRE}}`, `{{EMPRESA_SIGLA}}`, `{{EMPRESA_DIRECCION}}`, `{{CIUDAD_EMISION}}` | Registro `Company` y configuración institucional aprobada; el logo es un recurso de plantilla, no texto inyectado |
| `{{DESTINATARIO}}`, `{{MOTIVO_EMISION}}` | Entrada opcional del solicitante revisada por el aprobador; no debe convertirse en afirmación laboral no verificada |
| `{{FIRMANTE_NOMBRE}}`, `{{FIRMANTE_CARGO}}` | Perfil del aprobador autorizado que firma el documento final |
| `{{FECHA_EMISION}}` | Fecha de emisión fijada por el servidor en la zona horaria institucional |

El motor acepta únicamente esta lista blanca de variables, sin expresiones, consultas, HTML activo ni ejecución de código. Al aprobar una plantilla valida sintaxis, variables, datos requeridos y que la variante sin salario no contenga `S_ACT`. En la emisión vuelve a validar la disponibilidad de cada dato: si falta uno requerido, bloquea el PDF y registra un error controlado, en lugar de dejar `{{VARIABLE}}` visible o sustituirlo por un texto engañoso. Escapa los valores al renderizar y limita longitud y formato para evitar inyección o desbordamiento del PDF.

`CertificateIssuance` conserva `template_id`, `version`, `content_hash`, versión/snapshot del empleado, valores resueltos o una referencia cifrada e inmutable a ellos, estado de aprobación, firmante, modalidad y evidencia de firma, hash del PDF final, instante y usuario. Se conserva el PDF firmado emitido; una modificación de plantilla, salario o cargo no altera lo ya expedido. Los accesos a plantillas con salario y a documentos emitidos se auditan.

#### 6.1.2 Referencia visual, aprobación y firma

El archivo suministrado `CertificadoLaboral.pdf` es la referencia de presentación. Contiene logo Bolton, razón social GRALCO, encabezados «POR SOLICITUD DE LA PARTE INTERESADA» y «HACE CONSTAR», párrafo de identidad/vinculación/cargo/salario, motivo y destinatario, despedida, firma con nombre y cargo, sello y datos de contacto en el pie. El archivo es una imagen escaneada, girada 180 grados y con información de 2024; no se debe usar como PDF de fondo con nombres, fechas, salario o firma impresos. Reconstruir su composición como plantilla limpia de PDF, con logo institucional autorizado, contenido dinámico y un área de firma. La marca y los datos de pie se administran en la configuración de la empresa.

El texto parametrizado puede incluir `{{DESTINATARIO}}` y `{{MOTIVO_EMISION}}` opcionales, proporcionados por el solicitante y revisados por el aprobador, además de `{{FIRMANTE_NOMBRE}}` y `{{FIRMANTE_CARGO}}` tomados del perfil autorizado. `TIPO_CONTRATO` ya se exporta como código del catálogo; no escribir «a término indefinido» por defecto. Tampoco consta una fecha de terminación: «hasta la fecha actual» solo aplica si el código `EST = V` al emitir. El salario en letras se calcula de `S_ACT` y se compara con el importe numérico; no se copia del ejemplo.

| Estado | Transición y responsable |
| --- | --- |
| `SOLICITADO` | El empleado elige variante con/sin salario y contrato; puede indicar destinatario y motivo. |
| `PENDIENTE_APROBACION` | Se fija snapshot y versión de plantilla, se validan campos y se genera vista previa. |
| `DEVUELTO` o `RECHAZADO` | El aprobador consigna motivo; una corrección crea nueva revisión. |
| `APROBADO_PENDIENTE_FIRMA` | El aprobador verifica contenido, identidad, contrato y salario cuando aplica. |
| `EMITIDO` | Se firma el PDF final, se almacena y se habilita la descarga al empleado. |

El permiso `CERTIFICATE_APPROVER` se asigna a personas concretas con alcance de empresa y vigencia. El servidor verifica permiso e identidad **al firmar**, no solo al abrir la bandeja. Se requiere una firma de una persona autorizada; administrar plantillas no otorga por sí mismo permiso para firmar. La autoaprobación de certificados propios se bloquea salvo política expresa.

Se permite mostrar la imagen escaneada de la firma de la persona aprobadora, almacenada con acceso restringido y vinculada exclusivamente a ese usuario. La firma electrónica interna exige además autenticación reforzada, acto explícito de firma y evidencia de quién firmó, cuándo, IP, versión y hash del PDF. La imagen escaneada **no demuestra por sí sola** la aprobación. La aplicación inserta la imagen solo tras el acto autorizado; no permite que el editor de plantillas la pegue o que otro usuario la seleccione. Toda modificación posterior exige nueva revisión y firma. Se conserva el PDF emitido, su hash y la evidencia; la validez de una firma digital criptográfica requeriría un mecanismo adicional.

### 6.2 Solicitudes de vacaciones y permisos

`PROG_VAC` es la tabla de períodos programados. La importación inicial usa las columnas reales del archivo recibido: `N_IDE`, `N_CONT`, `PER_INI`, `PER_FIN`, `DIAS`, `DISP`, `EST`. `PER_INI` y `PER_FIN` son fechas del período (en el ejemplo vienen como texto `DD/MM/AAAA`), `DIAS` son los días hábiles programados (15 o menos) y `DISP` son los días hábiles disponibles tras disfrutes anteriores; validar `0 <= DISP <= DIAS <= 15`. Se guarda fecha de corte y versión de la carga; aprobaciones posteriores restan días hábiles de `DISP`, con ajustes administrativos versionados. `DISP = 0` produce estado interno `LIQUIDADA` y el período no se ofrece para nuevas solicitudes. `EST` del origen se conserva separado de ese estado interno hasta conocer sus códigos. El administrador mantiene `PROG_VAC` mediante Excel y CRUD. Las claves `N_IDE` y `N_CONT` se importan como texto; si Excel las almacena como números, se advierte el riesgo de perder ceros y se exige que sean enteros representables antes de convertirlos.

El empleado puede seleccionar **uno o varios registros `PROG_VAC`** con `DISP > 0` de su contrato vigente. El formulario muestra por período sus fechas, `DIAS` y `DISP`, y permite elegir `0 < días_hábiles_elegidos <= DISP`. `VacationRequestAllocation` registra la distribución de cada período en una solicitud; el total elegido es la suma. Una solicitud produce un intervalo continuo de disfrute. La aprobación final bloquea todos los períodos seleccionados, valida nuevamente su `DISP` y descuenta cada asignación en una sola transacción. Los períodos con `DISP = 0` quedan `LIQUIDADA`. Solicitudes pendientes, rechazadas o canceladas no consumen días.

`VACACIONES` es la tabla de **disfrutes aprobados**, distinta de `PROG_VAC`. Cada aprobación crea una fila con `N_IDE`, `N_CONT`, identificador de solicitud/revisión, `FEC_INI_DIS`, `FEC_FIN_DIS`, `DIAS_DIS` y `FECHA_RETORNO`, más referencias a las asignaciones por período. `DIAS_DIS = FEC_FIN_DIS - FEC_INI_DIS` es la **diferencia literal en días calendario**, sin sumar uno, tal como se confirmó; por ejemplo, si ambas fechas coinciden, `DIAS_DIS = 0` aunque se haya aprobado un día hábil. Los días hábiles aprobados que se descuentan de `PROG_VAC.DISP` son la suma de asignaciones y se almacenan aparte como `DIAS_HABILES`; nunca se resta `DIAS_DIS` de `DISP`. Las interfaces y los PDF deben distinguir expresamente la diferencia calendario `DIAS_DIS` de los días hábiles aprobados para evitar interpretaciones erróneas.

`HolidayCalendar` almacena festivos por empresa, país/región y fecha; 6.2.1 define API y respaldo local. Se exige calendario publicado que cubra el intervalo y la fecha de retorno, incluso si cruza de año. `FEC_INI_DIS` debe ser hábil. Desde ese día, inclusive, se suman únicamente lunes a viernes no festivos hasta completar `DIAS_HABILES`, igual a la suma de días aprobados de todos los períodos; el último día hábil contado es `FEC_FIN_DIS`. Los sábados, domingos y festivos intermedios extienden el intervalo calendario sin consumir `DISP`. `FECHA_RETORNO` es el primer día hábil posterior a `FEC_FIN_DIS`, saltando sábados, domingos y festivos consecutivos. Se fija la versión del calendario y la lista de días contados en la revisión aprobada. Si no hay calendario completo, no se aprueba.

1. Al enviar, se resuelve en `AREA` (`C_EMP`, `C_AREA`) la asignación vigente de un usuario con rol `AREA_MANAGER`; si no existe un único aprobador vigente o una suplencia autorizada, no se envía al flujo. El empleado acepta la revisión con períodos, asignaciones, fecha inicial y fechas calculadas.
2. El jefe puede proponer cambios en períodos, días o fecha inicial con motivo. Una revisión nueva recalcula fechas y requiere nueva aceptación del empleado.
3. El jefe aprueba y luego un usuario con rol `VACATION_FINAL_APPROVER` da la aprobación final sobre la misma revisión. Cualquier cambio posterior requiere de nuevo las acciones de quienes ya aprobaron.
4. En transacción se validan calendario y remanentes, se crea `VACACIONES`, se registran asignaciones y se actualizan `PROG_VAC.DISP` y estados. Se emite PDF con firmas visuales del empleado, jefe y aprobador final, cada una insertada tras la acción autenticada de su titular. Rechazos y devoluciones no crean un disfrute. Correcciones posteriores usan reversión/ajuste trazable.

Las imágenes de firma son privadas y se asocian a cada cuenta; una imagen sola no demuestra aprobación. Se registra actor, fecha, revisión y hash. Los permisos se tramitan por tipo: inicialmente el empleado solicita y el jefe decide, con escalamiento cuando una regla aprobada lo requiera. Los permisos no consumen `PROG_VAC.DISP`.

#### 6.2.1 Fuentes de festivos y continuidad

NOMFLOW consulta del lado servidor la [API de Festivos Colombia](https://www.festivos.com.co/api/documentacion), versión `v1`, mediante `GET /api/v1/festivos?year=AAAA` y `Authorization: Bearer <API_KEY>`. La documentación indica respuestas JSON con `data[].date` y `name_es`, así como límites de 20 consultas/minuto y 1000/día por clave; se consulta por año, se valida formato y cobertura, y se almacena una versión local con fecha de sincronización y origen `API`. La clave se guarda como secreto del servidor y no se envía al navegador ni se coloca en URL.

El administrador también puede cargar cada año por Excel `FESTIVOS` o editarlo mediante CRUD, con origen `EXCEL`/`MANUAL`, fecha, motivo y versión. La tabla local publicada es la fuente inmediata del cálculo; la API actualiza propuestas de calendario que el administrador puede revisar/publicar, sin alterar una versión ya usada por solicitudes firmadas. Las fechas locales complementarias o correcciones se conservan y una nueva sincronización no las borra silenciosamente. Se comparan diferencias y se registra quién publicó la versión final.

Si la API responde con error, agota tiempo, devuelve datos incompletos o alcanza el límite de uso, el sistema usa la **última versión local publicada y completa** para todos los años requeridos. Reintenta la sincronización después con límite y alerta al administrador; no llama a la API por cada día del cálculo. Si no hay tabla local completa ni respuesta válida, bloquea nuevas aprobaciones y muestra el año faltante. Se prueban fallos 401/429/5xx, cruce de año y cambios de un calendario previamente publicado. La API documenta 401 por clave inválida y 429 por límite.

### 6.3 Certificados tributarios y exportación de salida

Gestión Humana carga el certificado tributario anual como PDF, asociado a `N_IDE + AÑO`, con comprobación de tipo, integridad, usuario cargador y vista previa. Si se reemplaza, conservar versiones y publicar una sola versión vigente. El empleado activo descarga solo sus propios años. No deducir el año fiscal del nombre del archivo; debe capturarse y verificarse al cargar.

Antes de aplicar `EST = C`, el administrador notifica al empleado según `PRE_BAJA_AVISO_DIAS` y habilita la descarga de un ZIP con **todos** sus volantes publicados, certificados tributarios y constancias/documentos aprobados de vacaciones, incluidos contratos históricos vinculados al mismo `N_IDE`. La notificación registra fecha prevista de baja, fecha efectiva, canal, plazo parametrizado y versión del parámetro; el sistema registra la descarga o su ausencia. Generación asíncrona, manifiesto de archivos y versiones, control de integridad, archivo cifrado o canal autenticado con caducidad corta, límite de uso y auditoría. Probar ZIP grande y generar reporte de faltantes; no marcarlo completo si faltan fuentes obligatorias. Si llega `EST = C` sin aviso previo, se registra incumplimiento y se bloquea el acceso de inmediato. Un administrador autorizado puede consultar y descargar los documentos de cualquier empleado en cualquier momento, con propósito declarado y auditoría; para entregar documentos después de la baja verifica identidad mediante proceso externo y no reactiva la cuenta.


## 7. Reglas de implementación y verificación

TypeScript estricto, validación de toda entrada, autorización del lado servidor y auditoría de cambios y descargas. Los estados de solicitud, revisión, aprobación, firma, publicación y baja se implementan como transiciones explícitas, transaccionales e idempotentes donde corresponda. Respuestas de error sanitizadas, sin trazas ni datos sensibles. La importación no publica datos parciales; las operaciones concurrentes sobre períodos de vacaciones y versiones de nómina se serializan. La generación de PDF parte de datos y plantillas versionados; documentos emitidos son inmutables. Cada módulo entrega contratos API, migraciones, pruebas de permisos y escenarios de error que demuestren sus criterios de aceptación.

## 8. Plan de implementación

1. **Fundación:** repositorio, CI, base de datos, organización/roles, alta administrativa con clave temporal, verificación SMTP del correo y sesiones; datos sintéticos y control de acceso.
2. **Datos y administración:** catálogos CRUD, importaciones Excel de `EMPLEADOS`, `PROG_VAC` y nómina, revisión de lotes y auditoría. Mapear `C_ARE`/`NOMAREA` del archivo `AREAS.xlsx` a `C_AREA`/`AREA` de la tabla `AREA`, vincular jefes usuarios con rol aprobador y exigir `EST` en `V`/`C`; corregir el `A` erróneo del archivo de empleados.
3. **Autoservicio documental:** volantes PDF, certificados tributarios PDF, plantillas/certificados laborales con aprobador, firma interna y código de validación, ZIP y aviso previo a baja.
4. **Solicitudes:** períodos vacacionales múltiples por solicitud, calendario de festivos, fechas calculadas, permisos, revisiones, imágenes de firma autorizadas de empleado/jefe/aprobador final y constancias PDF.
5. **Endurecimiento y lanzamiento:** pruebas integrales, amenazas y seguridad, respaldo/restauración, rendimiento, accesibilidad, despliegue, monitoreo y procedimiento operativo. Las decisiones abiertas de la sección 12 son gates de las funcionalidades que las requieren, no supuestos silenciosos.

## 9. NOMFLOW: integración con nómina externa mediante Excel

Esta sección detalla la importación del modelo canónico de la sección 5. La fuente oficial de empleados y pagos es el sistema externo. NOMFLOW conserva una copia sincronizada de solo lectura para el portal y es dueño de cuentas, solicitudes, aprobaciones y auditoría. La importación desde archivos `.xlsx` es el mecanismo inicial; una conexión o API futura debe usar el mismo contrato de datos y validaciones.

### 9.1 Plantillas y correspondencia de campos

Se aceptan libros separados o un libro con hojas `EMPRESA`, `AREA`, `CCOSTOS`, `CARGOS`, `TIPO_CONTRATO`, `EMPLEADOS`, `PROG_VAC`, `FESTIVOS` y `NOMINA`, según el tipo de carga declarado. La primera fila contiene encabezados mapeados explícitamente, sin columnas duplicadas ni filas de título adicionales. El archivo recibido `PROG_VAC.xlsx` usa `Hoja 1` como nombre físico de hoja: el importador permite elegir el tipo `PROG_VAC` y asignar esa hoja, sin inferirlo del nombre del archivo. El servidor lee valores de celdas, no ejecuta fórmulas, macros ni enlaces externos. Cada fila representa un registro del origen. Cargar primero catálogos organizacionales y tipos de contrato, después empleados y períodos, y luego nómina; rechazar referencias inexistentes o poner el lote en observación.

| Hoja | Columnas obligatorias del archivo | Interpretación |
| --- | --- | --- |
| `EMPRESA` | `C_EMP`, `NOMBRE`, `SIGLA`, `DIRECCION` | Configuración institucional; logo y datos de contacto se cargan/configuran de forma controlada con versión y permisos. |
| `AREA` | `AREAS.xlsx`: `C_ARE`, `NOMAREA`, `JEFE_AREA`; `C_EMP` se elige como metadato de carga. | Mapear `C_ARE` a `C_AREA` y `NOMAREA` a `AREA` del modelo/empleado. Los 23 códigos usados por `EMPLEADOS.xlsx` están presentes y sus nombres coinciden. `JEFE_AREA` está vacío en las 29 filas; asignar jefe verificado y vigencia en `AreaManagerAssignment`. |
| `CCOSTOS` | El archivo `CCOSTOS.xlsx` recibido contiene `C_COS`, `CCOSTO`; el modelo interno usa `C_EMP`, `C_COS`, `NOMCOSTOS`. | Al importar, seleccionar explícitamente la empresa `C_EMP` y mapear `CCOSTO` a `NOMCOSTOS`; no inferir empresa ni exigir columnas ausentes en el archivo. Clave única interna `(C_EMP, C_COS)`. |
| `CARGOS` | `CARGOS.xlsx` contiene `C_CAR`, `CARGO`; `C_EMP` se elige como metadato de carga. | Mapear `CARGO` a `NOMCAR`. Exigir clave única `(C_EMP, C_CAR)` con una descripción verificada; detener la publicación ante códigos repetidos con textos diferentes y resolverlos en la fuente o mediante una clave adicional oficial. |
| `TIPO_CONTRATO` | `tipo_contrato.xlsx` contiene `TIPO_CONTRATO`, `NOMCONTRATO`. | Cinco códigos de texto únicos (`01` a `05`) y sus descripciones. Preservar el cero inicial; publicar catálogo versionado y validar claves de empleados contra él. No convertir automáticamente descripciones del empleado en códigos si la correspondencia no es exacta y única. |
| `EMPLEADOS` | `EMPLEADOS.xlsx`: `C_EMP`, `N_IDE`, `NOMBRE`, `C_COS`, `CCOSTO`, `S_ACT`, `N_CONT`, `C_CAR`, `C_AREA`, `FEC_NAC`, `CARGO`, `AREA`, `HLIQ`, `SEXO`, `F_INI`, `TURNO`, `EST`, `EMAIL`, `NOMBRES`, `APELLIDOS`, `CELULAR`, `PROFESION`, `NIVELEDUCATIVO`, `TIPO_CONTRATO`. | La tabla tiene exactamente esta estructura. La muestra trae 240 `N_IDE`/`N_CONT`/`EMAIL` únicos y códigos contractuales válidos, pero `EST = A` en 240 filas por error: rechazar el lote hasta recibir `V`/`C` según la regla confirmada. `CELULAR` está vacío en tres filas y es opcional. |
| `PROG_VAC` | En el Excel recibido: `N_IDE`, `N_CONT`, `PER_INI`, `PER_FIN`, `DIAS`, `DISP`, `EST`; `FECHA_CORTE` se registra como metadato del lote. | Migración inicial de períodos y remanentes. `PER_INI`/`PER_FIN` son fechas `DD/MM/AAAA` en la muestra; `DIAS` y `DISP` numéricos. `DISP = 0` produce `LIQUIDADA` interno; `EST` externo se conserva sin asumir equivalencia. |
| `FESTIVOS` | `C_EMP`, `REGION`, `FECHA`, `DESCRIPCION` | Carga anual alternativa/complementaria a la API; versión local publicada por empresa/región y año. |
| `NOMINA` | `PER`, `N_LIQ`, `N_IDE`, `CONTRATO`, `NOMBRE`, `C_CON`, `CONCEPTO`, `SLRIO`, `CANT`, `DED`, `DEV`, `TERCERO` | Detalle histórico de cada liquidación. `SLRIO` es el salario al momento del pago; `DED` y `DEV` son importes monetarios. `CANT` es una cantidad en horas o días según el concepto. |

Una columna obligatoria puede tener celdas vacías **solo** cuando el esquema de origen permite nulos y el caso de uso no la exige. En `EMPLEADOS`, `N_IDE`, `N_CONT` y `EMAIL` son obligatorios; para crear cuentas se exige correo normalizado único por `N_IDE`, `C_AREA` enlazada, exactamente un contrato `EST = V` por persona y código `TIPO_CONTRATO` del catálogo. `EST` admite `V` (vigente) o `C` (cancelado): cualquier otro valor, incluido `A` del Excel de muestra, invalida el lote o deja la fila en cuarentena, sin activar acceso. `EST = C` revoca sesiones y descargas al aplicarse. Las claves `C_EMP + C_AREA`, `C_EMP + C_COS` y `C_EMP + C_CAR` se validan con mapeos de catálogos; conflictos entre código y descripción se reportan sin elegir valores arbitrarios. En `NOMINA` no pueden estar vacíos `PER`, `N_IDE`, `CONTRATO` ni `C_CON`. `N_LIQ` se exige para publicar un volante, aunque la vista lo declare nullable. Los importes nulos se interpretan como cero solo en los cálculos del volante; se conserva el original para trazabilidad.

`CCOSTOS.xlsx` contiene 25 filas y 24 códigos distintos. Los 24 códigos `C_COS` de `EMPLEADOS.xlsx` figuran en el catálogo y sus descripciones coinciden con al menos una fila, pero `FA1403` aparece dos veces con descripciones distintas (una variante con carácter ilegible). El lote de catálogo se detiene para resolver la duplicidad y codificación en el origen; no elegir una descripción arbitraria. Tras corregirla, reconciliar `(C_EMP, C_COS)` y `CCOSTO` del empleado con `NOMCOSTOS` interno; conservar observaciones y versión del lote.

`AREAS.xlsx` contiene 29 códigos `C_ARE` distintos; los 23 `C_AREA` usados por empleados y sus descripciones concuerdan tras el mapeo. `JEFE_AREA` viene vacío y no es la vinculación operativa. El administrador asocia en la tabla `AREA` cada código con un usuario de NOMFLOW que tenga rol `AREA_MANAGER`, con vigencia y suplencia auditadas. Se exige un aprobador resoluble al crear solicitudes; el cambio de jefe no altera aprobaciones históricas.

`CARGOS.xlsx` contiene 167 filas y 148 códigos `C_CAR` distintos: 17 códigos se repiten con descripciones distintas. Los 123 códigos usados por `EMPLEADOS.xlsx` existen y cada descripción coincide con alguna fila; 15 de esos códigos son ambiguos en el catálogo. Rechazar publicación del lote como catálogo de clave única hasta corregir el origen o documentar una clave compuesta oficial; no elegir la primera o última fila ni usar `CARGO` libre como sustituto permanente de una clave estable.

`tipo_contrato.xlsx` define cinco códigos (`01`–`05`) con `TIPO_CONTRATO`/`NOMCONTRATO`, sin claves duplicadas. Los 240 `TIPO_CONTRATO` de `EMPLEADOS.xlsx` son códigos de texto presentes en el catálogo, sin vacíos; conservar ceros iniciales y obtener `NOMCONTRATO` de la versión publicada para certificados.

El exportador debe preservar `N_IDE`, `N_CONT`, `CONTRATO`, `C_CON`, `CODBIO` y códigos semejantes como **texto**, incluso si contienen solo dígitos, para evitar pérdida de ceros iniciales o notación científica. En `PROG_VAC.xlsx` de muestra `N_IDE` y `N_CONT` vienen como celdas numéricas: advertirlo y validar conversión entera sin fracción; una cifra ya truncada por Excel no puede recuperarse automáticamente. `PER` de nómina se recibe como seis dígitos `AAAAMM`; `N_LIQ` admite `1` o `2`. Las fechas de `EMPLEADOS` son celdas fecha en la muestra y `PER_INI`/`PER_FIN` de `PROG_VAC` son textos `DD/MM/AAAA`: cada plantilla tiene parser explícito. Los importes se convierten a decimal exacto, sin `Float`.

### 9.2 Alcance de una carga y publicación

Cada carga declara antes de procesarse: tipo de hoja/catálogo, sistema origen, responsable y, para `NOMINA`, un único `PER` y `N_LIQ`. El archivo de nómina no puede mezclar liquidaciones fuera de ese alcance. Exportar **todas** las filas de la liquidación declarada; la carga es una instantánea completa del archivo entregado, no una acumulación de filas. Esto permite repetirla sin duplicar conceptos y detectar correcciones. Una exportación parcial debe rechazarse o usar un protocolo incremental separado que proporcione identificadores estables de línea y operaciones explícitas. La comparación contra el mismo archivo demuestra fidelidad de importación, no integridad de la exportación desde el sistema externo.

El encabezado lógico de un volante se identifica por `N_IDE + PER + N_LIQ + CONTRATO`. Puede haber varios conceptos e incluso líneas aparentemente iguales dentro de un volante; no se debe deduplicar por `C_CON`. La suma de `DEV` es el total devengado, la suma de `DED` el total deducido y su diferencia el neto. La unidad de `CANT` no puede inferirse de su valor: requiere un catálogo de conceptos con unidad (`HORAS`, `DIAS` u otra) o debe mostrarse como cantidad sin etiqueta de unidad hasta contar con él.

El PDF presenta logo y razón social configurados, nombre, identificación, contrato, período y quincena, salario histórico `SLRIO`, conceptos, cantidades, totales y neto. Si hay valores distintos de `SLRIO` en un mismo volante, la carga se marca para revisión antes de publicar; no se elige arbitrariamente el primero. La fecha de generación del PDF es diferente de la fecha del pago y debe rotularse como tal. No se inventan fecha de pago, firma ni autorización de descuentos a partir de las vistas.

### 9.3 Proceso de importación

1. Un usuario con rol autorizado carga el `.xlsx` por HTTPS. El servidor aplica límites configurables de tamaño y filas, verifica tipo real de archivo, registra SHA-256, protege temporalmente el archivo y crea un lote con estados `RECIBIDO`, `VALIDANDO`, `OBSERVADO`, `LISTO`, `APLICANDO`, `APLICADO` o `FALLIDO`.
2. Un proceso en segundo plano analiza el libro en *staging* y genera un informe de errores por hoja, fila, columna, valor y regla. Rechaza encabezados incorrectos, períodos mezclados, datos incompatibles, empleados sin identificación, importes no numéricos y referencias ambiguas. No se modifica información visible al empleado durante esta fase.
3. El operador revisa una vista previa: filas del Excel, empleados distintos y volantes afectados, suma exacta de `DEV` y `DED`, diferencias frente a la versión publicada, registros sin correspondencia y advertencias. Al aplicar la carga, comparar el **número de filas del Excel** con las filas persistidas para ese lote y las sumas `DEV` y `DED` del Excel con las sumas persistidas (precisión decimal de origen). Registrar ambos lados, el resultado y filas rechazadas. Si difieren, revertir el lote completo; no publicar.
4. Solo un lote válido, comparado con su archivo y confirmado por operador autorizado pasa a aplicación/publicación. En una transacción se bloquea el alcance `(PER, N_LIQ)`, se escribe una nueva versión de la instantánea, se verifica conteo y sumas de esa versión y se cambia el puntero de versión publicada. Un error revierte toda la operación. Se registra quién confirmó, cuándo, hash del archivo y conteos/totales antes y después. Esto no garantiza que el Excel contenga toda la nómina producida por el sistema externo.
5. El mismo archivo y alcance no generan una segunda versión si su contenido canónico es igual. Una carga corregida crea una versión nueva; las versiones publicadas anteriores y sus metadatos de descarga permanecen auditables. No se borra una liquidación porque falte una fila en una carga fallida o parcial.
6. Las cargas de `EMPLEADOS` actualizan el perfil vigente mediante conciliación por `N_IDE` y contrato. Ausencias en el archivo se reportan y no causan baja automática. Los cambios de identificación o fusiones de personas requieren resolución administrativa documentada; no se vinculan por nombre. Un cambio explícito a `EST = C` revoca sesiones y acceso de esa persona al aplicar la carga, incluso si tiene un ZIP previo aún vigente.

### 9.4 Modelo persistente mínimo

- `ImportBatch`: tipo, alcance, origen, hash del archivo, estado, usuario, tiempos, conteos, totales, errores y versión resultante.
- `Company`, `AREA`, `CostCenter` (`CCOSTOS`), `JobPosition` (`CARGOS`) y `AreaManagerAssignment`: identidad de empresa, marca/dirección, catálogos y jefe con vigencia.
- `EmployeeSnapshot`: `N_IDE`, `N_CONT`, `EMAIL`, `C_AREA`, `AREA`, demás campos actuales de `EMPLEADOS`, fecha y lote de origen. La cuenta se vincula a identidad verificada; `EST = C` bloquea acceso del empleado.
- `PROG_VAC`, `VacationRequest`, `VacationRequestAllocation`, `VacationRevision`, `VACACIONES` y `ApprovalAction`: varios períodos por solicitud, asignación hábil por período, `DISP`, fechas calculadas, `DIAS_DIS` calendario, retorno, revisiones y firmas visuales/evidencia.
- `HolidayCalendar`: festivos, región, año y versión publicada usada para calcular días hábiles.
- `CertificateTemplate` y `CertificateIssuance`: texto editable y versionado del certificado, más constancia inmutable de cada emisión según la sección 6.1.1.
- `PayrollVersion`: `PER`, `N_LIQ`, número de versión, estado de publicación, hash canónico, lote, fecha y totales.
- `PayrollLine`: versión, `N_IDE`, `CONTRATO`, `C_CON`, `CONCEPTO`, `SLRIO`, `CANT`, `DED`, `DEV`, `TERCERO`, nombre de origen y orden/índice de fila para trazabilidad. Su identificador interno es independiente del código de concepto.
- `PayrollDownloadAudit`: identidad, volante, versión publicada, instante y resultado de la descarga. Si se conserva un PDF emitido, registrar su hash y la versión de datos utilizada.

Los importes se almacenan con precisión decimal suficiente para `NUMBER(18,6)` del origen. En la vista previa y **en cada descarga PDF**, el usuario elige un modo de presentación: `SIN_AJUSTE` (muestra los decimales originales, hasta 6 posiciones decimales) o `ENTERO_SUPERIOR` (aplica `ceil` matemático a cada `DEV`, `DED` y `SLRIO` mostrado). El modo inicial sugerido por configuración de empresa puede ser `ENTERO_SUPERIOR`, pero el empleado puede cambiarlo para su descarga sin modificar el origen ni los PDFs ya emitidos. La API valida el valor de una lista cerrada y registra la opción elegida en la auditoría y metadatos de generación.

Con `SIN_AJUSTE`, `TOTAL_DEV = suma(DEV_línea)`, `TOTAL_DED = suma(DED_línea)` y `NETO = TOTAL_DEV - TOTAL_DED`, usando precisión original. Con `ENTERO_SUPERIOR`, `TOTAL_DEV = suma(ceil(DEV_línea))`, `TOTAL_DED = suma(ceil(DED_línea))` y `NETO = TOTAL_DEV - TOTAL_DED`; los totales visibles cuadran con cada línea visible. Por ejemplo, `ceil(-1,2) = -1` si hay reversos negativos. La comparación de importación Excel–base de datos **siempre** usa los decimales originales, sin ajuste. El PDF identifica claramente el modo aplicado y el hash/versión de nómina, e indica que el ajuste es solo de presentación y no modifica la liquidación pagada. Dos descargas del mismo volante con modos distintos pueden tener netos presentados diferentes sin que cambie la liquidación fuente. Para conciliación oficial se usan los importes originales, no los presentados en `ENTERO_SUPERIOR`. Los índices deben cubrir `N_IDE, PER, N_LIQ, CONTRATO` y la versión publicada. La importación y el acceso a las filas exigen autorización de servidor, aislamiento por empleado, cifrado en tránsito, permisos mínimos, retención definida para archivos de origen y auditoría sin salarios ni documentos completos en logs técnicos.

### 9.5 Criterios de aceptación

- Una carga repetida del mismo archivo no duplica conceptos ni cambia el volante.
- Un archivo con errores no altera los datos publicados y entrega un reporte descargable de errores.
- Una corrección aceptada deja consultable la trazabilidad de la versión anterior y el empleado recibe siempre la versión publicada vigente.
- Un empleado no puede consultar ni descargar volantes de otro `N_IDE`, incluso modificando parámetros de la URL o API.
- Una liquidación de años anteriores muestra `SLRIO` histórico, aunque `S_ACT` del perfil sea diferente.
- Los importes y el neto del PDF coinciden con la versión importada y con la conciliación aprobada.
- El certificado laboral refleja el contrato y la versión de `EMPLEADOS` utilizados al emitirse; la opción con salario usa `S_ACT` y la opción sin salario no lo muestra ni lo incluye en metadatos públicos.
- Cambiar y aprobar una plantilla afecta solo las emisiones futuras; una variable desconocida o un dato requerido ausente impiden publicar o emitir, respectivamente.
- Un certificado no se ofrece como firmado ni se descarga como versión final antes de la firma de una persona que conserve el permiso `CERTIFICATE_APPROVER` en ese momento. El PDF y su hash quedan fijos tras firmar.
- Una nómina no se publica si el número de filas o las sumas de `DEV` y `DED` persistidas difieren de las del Excel cargado. El resultado se describe como **integridad de migración del archivo**, sin afirmar integridad del archivo frente al sistema externo.
- `EST = C` revoca sesiones y descargas; un ZIP solicitado antes de la baja incluye los documentos publicados de ese `N_IDE`, con manifiesto y caducidad, y no permanece accesible tras la baja.
- El administrador autorizado puede consultar/exportar documentos de personas vigentes o canceladas, con motivo y registro de acceso; la notificación previa a la baja y el resultado de la descarga se conservan.
- Un cambio de períodos, días o fechas de vacaciones genera nueva revisión y requiere aceptación/acción de firma del empleado, jefe y aprobador final sobre esa misma revisión.
- Dos aprobaciones concurrentes no pueden consumir más que `PROG_VAC.DISP`; varios disfrutes de un mismo programa se conservan como registros `VACACIONES` separados, con retorno, `DIAS_HABILES` asignados y `DIAS_DIS` calendario.
- Una solicitud puede consumir parcialmente varios períodos vigentes; al quedar cero, el período pasa a `LIQUIDADA`. El cálculo ignora sábados, domingos y festivos de todos los años que cruce el disfrute, conserva versión de calendario y fija `FECHA_RETORNO` en el siguiente lunes a viernes que no sea festivo después de `FEC_FIN_DIS`.
- El empleado puede descargar el mismo volante con `SIN_AJUSTE` o `ENTERO_SUPERIOR`; en ambos modos el detalle, totales y neto cuadran entre sí, se rotula el modo y la comparación de importación usa siempre los valores originales.
- El administrador puede crear, consultar, modificar y desactivar catálogos organizacionales desde la interfaz; los cambios se reflejan en nuevas emisiones sin alterar PDFs ya expedidos.
- `PROG_VAC` puede cargarse desde Excel y mantenerse por CRUD sin duplicar períodos ni permitir `DISP` negativo; una corrección registra actor, motivo y versión. `VACACIONES` se crea al aprobar el disfrute.
- Las pantallas administrativas permiten consultar y corregir los demás datos según la matriz de permisos; una operación de borrado no elimina nóminas publicadas, firmas, certificados emitidos ni auditoría.

### 9.6 Mantenimiento administrativo y operaciones CRUD

El administrador de NOMFLOW es responsable de mantener la estructura organizacional: `Company/EMPRESA`, `AREA`, `CCOSTOS`, `CARGOS`, asignaciones de jefes y configuración institucional (nombre, sigla, dirección, logo y datos de contacto). Cada entidad tendrá interfaz de alta, búsqueda/consulta, modificación y desactivación, además de carga Excel donde esté definida. Las pantallas deben mostrar origen y última modificación; las claves referenciadas no se eliminan físicamente. Los cambios de nombre o jefe tienen fecha de vigencia para conservar reportes y aprobaciones históricos.

`PROG_VAC` tiene carga Excel y CRUD bajo las reglas de la sección 6.2; `VACACIONES` registra disfrutes aprobados y admite correcciones formales versionadas. Para las demás tablas el sistema ofrece operaciones administrativas apropiadas, con esta matriz como contrato de acceso:

| Grupo de datos | Crear | Consultar | Actualizar | Eliminar/desactivar |
| --- | --- | --- | --- | --- |
| Empresa, áreas, centros de costo, cargos, jefes | Administrador o importación autorizada | Administrador; consultas de aplicación según necesidad | Administrador, con vigencia e historial | Baja lógica si no hay dependencias activas; conservar referencias históricas |
| `PROG_VAC` (períodos) | Administrador o Excel | Administrador y empleado propietario (solo su información) | Administrador con motivo, versión y recálculo de `DISP` | Baja lógica solo sin disfrutes ni solicitudes; en otro caso corrección compensatoria |
| `VACACIONES` (disfrutes) | Sistema tras aprobación final | Administrador y empleado propietario | Reversión/rectificación formal y nueva versión | Sin borrado físico de disfrutes aprobados |
| Empleados sincronizados | Importación y corrección administrativa excepcional | Administrador; empleado propietario según permisos | Importación versionada; corrección excepcional auditada que se reconcilia con el origen | Desactivación por `EST = C`; conservar historial y documentos |
| Nómina sincronizada | Importación versionada | Administrador y empleado propietario | Sustituir/publicar nueva versión del alcance; no editar líneas publicadas directamente | Retirar publicación bajo autorización y motivo; no borrar versión auditada |
| Certificados tributarios | Carga PDF por administrador | Administrador y empleado propietario | Nueva versión del PDF/año | Retiro lógico de publicación; mantener versiones |
| Plantillas y configuración de documentos | Administrador autorizado | Administrador; aprobador según flujo | Borrador nuevo y aprobación de versión | Retiro de versión; nunca alterar una ya usada para emitir |
| Solicitudes, firmas, documentos emitidos y auditoría | Actores del flujo o sistema | Propietario, responsables y administrador según alcance | Transiciones/revisiones nuevas, nunca sobrescribir evento firmado | Sin borrado físico por CRUD; corrección formal, anulación o retención controlada |

El CRUD se implementa mediante API y pantallas con validación de campos, permisos en servidor, búsqueda, paginación, control de concurrencia (versión/ETag), motivo para cambios sensibles y auditoría del valor anterior y nuevo sin exponerlo en logs técnicos. Las cargas Excel y el CRUD usan las mismas reglas de negocio y restricciones de base de datos. Los datos maestros pueden editarse; los hechos históricos, nóminas publicadas, firmas y PDFs emitidos se gestionan por nuevas versiones o anulaciones para que «actualizar» y «eliminar» no destruyan evidencia. Un administrador puede consultar los datos y documentos de cualquier usuario con motivo registrado, pero no firmar en nombre de otra persona por el solo hecho de ser administrador.

### 9.7 Alcance de las validaciones de carga

La carga de `PROG_VAC` y su CRUD corresponden al administrador; `VACACIONES` se alimenta de aprobaciones. La nómina compara el archivo recibido con lo persistido; no exige un reporte de control independiente. La integridad de la exportación del sistema externo queda fuera de esa comparación. Las decisiones adicionales están en la sección 12.

## 10. Continuidad del desarrollo, tracking y handoff entre sesiones

El repositorio de NOMFLOW debe conservar el estado del proyecto junto al código. Una conversación o el contexto de un agente no son la fuente de continuidad. Los archivos siguientes son parte del producto y se versionan en Git:

| Archivo o directorio | Propósito | Regla de actualización |
| --- | --- | --- |
| `docs/requirements/NOMFLOW_SSD.md` | Copia canónica de esta especificación, con requisitos identificados y criterios de aceptación. | Cambiar mediante PR vinculado a una decisión o solicitud. El archivo entregado aquí es la fuente inicial para crear esta ruta. |
| `docs/STATUS.md` | Estado actual: versión, módulo en curso, último commit validado, bloqueos y siguiente trabajo concreto. | Actualizar al cierre de **cada sesión de desarrollo**, antes de hacer handoff. Mantener breve; no es el historial completo. |
| `docs/sessions/YYYY-MM-DD-<tema>.md` | Bitácora de una sesión: objetivos, trabajo realizado, pruebas, decisiones y pendientes. | Crear una entrada por sesión con fecha y tema; si hay dos sesiones del mismo tema/día, añadir sufijo numérico. |
| `docs/CHANGELOG.md` | Mejoras y correcciones funcionales agrupadas por versión, incluida una sección `Unreleased`. | Actualizar en el mismo PR que cambia comportamiento visible, API, seguridad o datos. |
| `docs/decisions/ADR-NNN-<tema>.md` | Decisiones arquitectónicas, alternativas consideradas, consecuencias y sustituciones. | Crear ADR para decisiones que afecten integración, identidad, firma, almacenamiento, migraciones o seguridad. No sobrescribir una decisión histórica: marcarla reemplazada y enlazar la nueva. |
| `docs/traceability.md` | Matriz de requisito → incidencia → PR/commit → pruebas → versión. | Actualizar al implementar o cambiar requisitos. |
| Sistema de incidencias del repositorio | Backlog priorizado de características, defectos y deuda técnica. | Toda tarea implementable tiene identificador, responsable, estado y criterios de aceptación. |

### 10.1 Identificación y seguimiento de features

Asignar IDs estables a requisitos (`ESS-AUTH-001`, `ESS-IMPORT-001`, `ESS-PAY-001`, `ESS-CERT-001`, `ESS-LEAVE-001`) y a mejoras nuevas. Cada incidencia describe necesidad, alcance, datos implicados, riesgos, dependencias y criterios verificables. Estados mínimos: `BACKLOG`, `READY`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`. Marcar `DONE` solo después de integrar el PR y superar los criterios de aceptación; «código escrito» no equivale a terminado.

Una mejora de feature sigue esta secuencia: propuesta/incidencia → revisión de impacto en el SRS y ADR si aplica → implementación en rama → pruebas y evidencia → PR → revisión e integración → `CHANGELOG` y matriz de trazabilidad → cierre de incidencia. Si la mejora cambia importación, permisos, certificados o nómina, documentar migración, compatibilidad, efectos en documentos ya emitidos y plan de reversión. Los pendientes no resueltos conservan dueño y siguiente acción; nunca se describen como implementados.

### 10.2 Protocolo obligatorio al iniciar y cerrar una sesión

**Inicio:** leer `docs/STATUS.md`, la sesión previa, incidencias asignadas, SRS y ADR relevantes. Verificar rama, estado de trabajo (`git status`), último commit, dependencias y ambiente. No iniciar sobre cambios ajenos sin identificarlos. Registrar objetivo y alcance de la sesión y asociar las incidencias. Estimar el impacto de los cambios con el mapa del código (`docs/graphify.md`: `graphify affected`), sin indexar nunca datos reales.

**Durante:** registrar decisiones y desviaciones de alcance; abrir o actualizar incidencia para trabajos descubiertos. Ejecutar las verificaciones pertinentes al cambio y anotar comandos y resultados. No colocar información personal de empleados, salarios reales, archivos de nómina, secretos o certificados privados en bitácoras, incidencias, commits o evidencias.

**Cierre/handoff:** completar la bitácora, actualizar `STATUS.md`, `CHANGELOG.md` y trazabilidad cuando corresponda; confirmar estado de Git y dejar commits o PR identificables. Indicar expresamente qué funciona, qué falta, qué falló y cómo reproducirlo. Si el trabajo queda sin commit, registrar rutas, cambios y razón; no darlo por entregado. El siguiente desarrollador o agente debe poder continuar solo con el repositorio y los enlaces a incidencias/PR.

Formato mínimo de `docs/sessions/YYYY-MM-DD-<tema>.md`:

```markdown
# Sesión: YYYY-MM-DD - tema
- Responsable / agente:
- Objetivo e incidencias:
- Rama y commit inicial:
- Cambios realizados (rutas y comportamiento):
- Decisiones / ADR / cambios al SRS:
- Pruebas y evidencia (comando, resultado, entorno):
- Migraciones, configuración y datos de ejemplo necesarios:
- Bloqueos y riesgos:
- Estado final (hecho / parcial / pendiente):
- Rama, commit final y PR:
- Próximo paso exacto y responsable:
```

`STATUS.md` debe apuntar a la última bitácora y contener una tabla breve `módulo | estado | incidencia/PR | siguiente acción`. La bitácora es un registro, no una lista de deseos: las afirmaciones de funcionalidad deben citar una prueba, revisión o despliegue verificable. Una sesión sin cambios también se registra si modifica decisiones, riesgos o prioridades. En cada handoff se comprueba que enlaces y rutas referidas existan.

### 10.3 Criterios de finalización de una mejora

Una tarea se considera terminada cuando cumple los criterios de aceptación, añade pruebas apropiadas a los riesgos reales, supera el pipeline requerido, revisa autorización y datos sensibles cuando aplica, actualiza documentación/plantillas y migraciones, tiene PR aprobado e integrado y deja evidencia en trazabilidad y `CHANGELOG`. Una versión desplegada requiere además verificación posterior y referencia a la etiqueta o commit desplegado. Registrar cualquier limitación aceptada como incidencia vinculada.

## 11. Ciclo de desarrollo y gobierno de Git

### 11.1 Ramas, commits y solicitudes de cambio

- `main` contiene código integrado y desplegable; se protege contra pushes directos y force-push. Crear ramas cortas desde `main`: `feat/ESS-CERT-001-plantillas`, `fix/ESS-PAY-001-totales`, `docs/ESS-IMPORT-001-flujo` o `hotfix/ESS-AUTH-001-acceso`.
- Una rama atiende una incidencia o un conjunto pequeño y relacionado. Sincronizar con `main` antes del PR y resolver conflictos con revisión de la intención de ambos cambios. No reescribir historial compartido.
- Commits atómicos describen la intención, por ejemplo `feat(cert): versionar plantillas de certificados` o `fix(payroll): conservar salario histórico`. Referenciar la incidencia en el cuerpo o PR. No incluir datos reales de empleados, `.env`, claves, tokens, credenciales de firma, volcados de BD, Excel de producción ni PDFs privados. Mantener `.gitignore` y muestras sintéticas.
- Abrir PR con objetivo, requisito/incidencia, resumen de cambios, impacto en datos y seguridad, migraciones, pruebas con resultados, capturas sin datos personales cuando sean útiles, plan de reversión y actualización documental. Revisar el diff completo y pedir revisión de otro responsable; quien escribió el cambio no lo autoaprueba. Para reglas de nómina, identidad, permisos y firma, solicitar revisión del dueño funcional además de la técnica.
- Integrar únicamente con CI en verde, aprobaciones requeridas y conversaciones resueltas. Preferir squash para una secuencia de commits exploratorios o merge normal cuando el historial de commits aporta trazabilidad; documentar la política elegida en el repositorio. Borrar la rama remota después de integrar, conservando PR y commits integrados.

### 11.2 Gates de integración continua

En cada PR ejecutar como mínimo instalación reproducible desde lockfile, formato/lint, compilación y chequeo de tipos, pruebas unitarias e integración relevantes, validación de migraciones sobre una base de prueba, escaneo de dependencias y secretos, y análisis estático de seguridad. Los cambios de autorización deben probar acceso permitido y denegado (incluido `N_IDE` ajeno); los de importación deben probar idempotencia, archivo inválido y reversión transaccional; los de certificados deben probar plantilla, aprobación/firma, variantes con/sin salario y persistencia del PDF emitido. No usar nómina productiva en CI.

### 11.3 Migraciones, entornos, releases y reversión

Las migraciones de esquema son archivos versionados, revisados y ejecutados una sola vez por el mecanismo del proyecto. Una migración destructiva requiere estrategia de expansión, traslado/verificación de datos y retirada posterior, respaldo y procedimiento de recuperación ensayado. No editar una migración ya aplicada. Los cambios de plantilla de certificado y de instantáneas de nómina se versionan como datos, no mediante modificación retroactiva de documentos emitidos.

Promover el mismo artefacto probado por `dev` → `staging` → `producción`, con configuración y secretos externos por entorno. Etiquetar releases como `vMAJOR.MINOR.PATCH`, mantener notas derivadas de `CHANGELOG` y registrar commit, migraciones, hora, responsable y resultado de verificación. Desplegar desde un commit integrado y etiquetado, no desde un directorio local. Para revertir código, usar un release anterior o un commit de reversión revisado; para datos o migraciones, aplicar el procedimiento específico, porque revertir Git no revierte la base de datos ni documentos firmados. Un `hotfix` sigue PR, revisión, pruebas proporcionales y actualización de documentación, aunque tenga prioridad urgente.

### 11.4 Comandos de referencia para una tarea

```bash
git status --short
git switch main
git pull --ff-only
git switch -c feat/ESS-CERT-001-plantillas
# editar, validar y revisar el diff
git diff --check
git status --short
git add <rutas-específicas>
git commit -m "feat(cert): versionar plantillas de certificados"
git push -u origin feat/ESS-CERT-001-plantillas
# abrir PR y vincular incidencia, pruebas y handoff
```

No usar `git add .` sin revisar antes el estado y el diff, ni `reset --hard`, `clean -fd`, force-push o rebase de ramas compartidas para ocultar cambios. Si se detecta un secreto en Git, revocarlo y rotarlo antes de limpiar el historial mediante un procedimiento coordinado; eliminarlo en un commit posterior no lo retira de los commits anteriores.

## 12. Evaluación de preparación para el desarrollo

**La arquitectura y los flujos principales permiten iniciar el desarrollo por etapas, pero los archivos recibidos aún no permiten activar todas las cuentas ni cerrar los criterios de aceptación.** Las decisiones confirmadas son: alta administrativa y verificación del correo asociado a `N_IDE`; importación de remanentes de `PROG_VAC`, selección de varios períodos, descuento de días hábiles por aprobación y persistencia de disfrutes aprobados en `VACACIONES`; calendario de lunes a viernes sin festivos con API y tabla local de respaldo, y fecha de retorno en el siguiente día hábil; imagen de firma de cada participante en el pie del PDF de vacaciones; elección por el empleado entre importes originales y ajuste al entero superior para descargar el volante; comparación Excel–base de datos de nómina; plazo previo a la baja parametrizable y acceso administrativo auditado.

| Pendiente concreto | Alcance y decisión necesaria para cerrar |
| --- | --- |
| **Empleados y cuentas** | La estructura de la tabla `EMPLEADOS` es la de `EMPLEADOS.xlsx`, pero las 240 filas de muestra traen `EST = A` por error. Recibir archivo corregido con `V` (vigente) o `C` (cancelado) antes de publicar y crear cuentas; no transformar masivamente `A` sin corregir la fuente. El código `C` ya había sido acordado. |
| **Centros de costo** | `CCOSTOS.xlsx` usa `C_COS`/`CCOSTO`, carece de `C_EMP` y repite `FA1403` con una descripción dañada. Asociar la empresa al lote y corregir la fila duplicada en el origen antes de publicar el catálogo; el importador mapea `CCOSTO` a `NOMCOSTOS`. Los 24 códigos usados por empleados están presentes. |
| **Áreas y aprobadores** | Los 23 códigos de empleados concuerdan con `AREAS.xlsx`. Configurar en la tabla `AREA` un usuario con rol `AREA_MANAGER` para cada área con empleados, además de vigencias y suplencias; la columna `JEFE_AREA` del Excel está vacía y no se utiliza para inferir el usuario. |
| **Cargos** | `CARGOS.xlsx` repite 17 códigos con distintas descripciones. Corregir los datos del origen o definir una clave oficial que desambigüe antes de publicar el catálogo; asociar empresa al lote y mapear `CARGO` a `NOMCAR`. |
| **Migración inicial de vacaciones** | `PROG_VAC.xlsx` trae `N_IDE`, `N_CONT`, `PER_INI`, `PER_FIN`, `DIAS`, `DISP`, `EST`, pero solo una fila y no trae fecha de corte. Confirmar códigos `EST`, suministrar fecha de corte como metadato y ejemplos de varios períodos parcialmente disfrutados, liquidados y ajustados para validar `DISP` y el histórico de migración. |
| **Calendario de festivos** | Obtener credencial de la API y cargar/publicar al menos una versión local de cada año requerido para garantizar el respaldo. Confirmar región aplicable a cada empresa y quién aprueba diferencias entre API y correcciones locales. |
| **Certificado laboral y tipo de contrato** | Los 240 códigos `TIPO_CONTRATO` de la muestra son válidos frente al catálogo. Emitir solo con `EST = V` procedente de una carga corregida, además de firmantes autorizados y evidencia del acto de firma según 6.1.2. |
| **Muestras de nómina** | Proporcionar ejemplos anonimizados con importes fraccionarios y reversos negativos para probar ambos modos de presentación (`SIN_AJUSTE`, `ENTERO_SUPERIOR`), la etiqueta de ajuste y la conciliación de importes originales. |
| **Baja y conservación** | `PRE_BAJA_AVISO_DIAS` es configurable; establecer valor inicial, si cuenta días hábiles o calendario, canal de notificación, retención de PDFs/ZIP y entrega a ex empleados. Exigir fecha prevista con antelación del origen o del administrador para programar el aviso. El bloqueo inmediato al cambiar a `C` está decidido. |
| **Operación de producción** | Configurar SMTP, dominios, almacenamiento, respaldos, monitorización, roles/suplencias y aceptación funcional; documentar despliegue y restauración antes del lanzamiento. |

**Verificación de extremo a extremo requerida:** administrador crea cuenta y clave temporal; empleado verifica el código SMTP y cambia clave; rechazo de correo compartido, `EST` ausente, `A` erróneo o cualquier código fuera de `V`/`C` y dos contratos vigentes por `N_IDE`; importación de varios `PROG_VAC` con pendientes parciales; selección y descuento atómico de varios períodos, `VACACIONES` separados con `DIAS_HABILES` y `DIAS_DIS`, liquidación a cero, calendario que cruza de año y retorno calculado; API de festivos disponible, 401/429/5xx con uso de versión local publicada y bloqueo cuando ambas fuentes faltan; asignación de jefe usuario con rol `AREA_MANAGER` y firmas visuales solo tras acción de cada titular; importación repetida/inválida de Excel y aviso de identificadores numéricos; comprobante con salario histórico y ambas opciones de ajuste; certificado laboral con tipo contractual verificado o variante sin cláusula y código público; certificado tributario anual; aviso parametrizado y ZIP antes de baja, sesión revocada tras `C` y consulta administrativa auditada; respaldo y restauración. Registrar pruebas, responsables y resultado en trazabilidad.
