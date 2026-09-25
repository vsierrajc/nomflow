# ADR-005: Certificado laboral de autoservicio

- Estado: aceptada (2026-09-25). Modifica el flujo de la SSD 6.1 (que preveía aprobador y firma): el empleado obtiene el documento al momento, sin aprobación.

## Decisión (del usuario)

1. El empleado genera el certificado directamente, con la plantilla documentada y los datos de `EMPLEADOS` de su contrato vigente (`EST = V`, un solo contrato).
2. Estructura del PDF: encabezado con logo y nombre de la empresa; pie con los datos de la empresa; cuerpo tomado de una **tabla** de la base de datos, modificable por el administrador.
3. Dos tipos: **general** (sin destinatario) y **dirigido** (con destinatario, que escribe el empleado). Cuál se ofrece lo define el administrador (solo general, solo dirigido o ambos; en ese caso el empleado elige).
4. Los administradores consultan el **historial** de todas las solicitudes.
5. Cada documento lleva un **código de documento parametrizado** (código, versión y fecha del formato) para el control del sistema de gestión de la calidad.

## Diseño

- Tablas: `certificate_settings` (por empresa: modalidad, código/versión/fecha del formato, ciudad, firmante opcional, pie, máximo diario), `certificate_templates` (título y texto por empresa y tipo, versionados: guardar crea una versión nueva y retira la anterior; nunca se sobrescribe) y `certificate_requests` (historial: empleado, contrato, tipo, destinatario, versión de plantilla, código del formato, copia de los valores usados, objeto, sha256).
- Motor de plantillas con lista blanca de variables `{{NOMBRE}}`, `{{CARGO}}`, `{{S_ACT_LETRAS}}`…; texto plano, sin expresiones ni HTML; el valor sustituido no se vuelve a interpretar; si falta un dato que la plantilla usa, no se genera (nunca queda `{{VARIABLE}}` visible) y se indica cuál falta.
- Nombres de cargo, área, centro de costo y tipo de contrato salen de los catálogos activos (con el texto de `EMPLEADOS` como respaldo, salvo el tipo de contrato, que solo sale del catálogo).
- El salario solo aparece si el administrador incluye `{{S_ACT}}` en el texto; por omisión las plantillas no lo llevan.
- El PDF se guarda en el almacén de objetos (cifrado, ADR-003) y entra en el archivo histórico en la nube (ADR-004). La descarga verifica el sha256 y se audita, igual que la emisión y los cambios de plantilla y parámetros.
- Límite diario por empleado (10 por omisión); vista previa del administrador con datos ficticios y marca de agua, que no se registra como emisión.
- Los `Certificate*` de la SSD (aprobación, firma, código de validación público) quedan como mejora futura: el rol `CERTIFICATE_APPROVER` no interviene en este flujo.

## Consecuencias

- No hay control previo de un aprobador: el contenido lo gobierna el administrador (plantilla) y los datos vienen de `EMPLEADOS`. Un dato erróneo en `EMPLEADOS` produce un certificado erróneo.
- Sin firma ni código público de validación, el documento no es verificable por terceros más allá del código del formato y la referencia del historial.
- La ciudad de emisión y el pie llevan valores por omisión (Barranquilla, sin datos) hasta que el administrador los configure.
