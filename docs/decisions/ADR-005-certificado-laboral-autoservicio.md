# ADR-005: Certificado laboral de autoservicio

- Estado: aceptada (2026-09-25). Modifica el flujo de la SSD 6.1: el empleado obtiene el documento al momento, sin cola de aprobación, pero **firmado** por una persona designada.

## Decisión (del usuario)

1. El empleado genera el certificado directamente, con la plantilla documentada y los datos de `EMPLEADOS` de su contrato vigente (`EST = V`, un solo contrato).
2. Estructura del PDF: encabezado con logo y nombre de la empresa; pie con los datos de la empresa; cuerpo tomado de una **tabla** de la base de datos, modificable por el administrador.
3. Dos tipos: **general** (sin destinatario) y **dirigido** (con destinatario, que escribe el empleado). Cuál se ofrece lo define el administrador (solo general, solo dirigido o ambos; en ese caso el empleado elige).
4. Los administradores consultan el **historial** de todas las solicitudes.
5. Cada documento lleva un **código de documento parametrizado** (código, versión y fecha del formato) para el control del sistema de gestión de la calidad.
6. El certificado va **firmado** por una persona con el rol de firmante de certificados. En principio dos (el director financiero o la directora de Gestión Humana) y, en su defecto, el gerente general.

## Diseño

- Tablas: `certificate_settings` (por empresa: modalidad, código/versión/fecha del formato, ciudad, firmante opcional, pie, máximo diario), `certificate_templates` (título y texto por empresa y tipo, versionados: guardar crea una versión nueva y retira la anterior; nunca se sobrescribe) y `certificate_requests` (historial: empleado, contrato, tipo, destinatario, versión de plantilla, código del formato, copia de los valores usados, objeto, sha256).
- Motor de plantillas con lista blanca de variables `{{NOMBRE}}`, `{{CARGO}}`, `{{S_ACT_LETRAS}}`…; texto plano, sin expresiones ni HTML; el valor sustituido no se vuelve a interpretar; si falta un dato que la plantilla usa, no se genera (nunca queda `{{VARIABLE}}` visible) y se indica cuál falta.
- Nombres de cargo, área, centro de costo y tipo de contrato salen de los catálogos activos (con el texto de `EMPLEADOS` como respaldo, salvo el tipo de contrato, que solo sale del catálogo).
- El salario solo aparece si el administrador incluye `{{S_ACT}}` en el texto; por omisión las plantillas no lo llevan.
- El PDF se guarda en el almacén de objetos (cifrado, ADR-003) y entra en el archivo histórico en la nube (ADR-004). La descarga verifica el sha256 y se audita, igual que la emisión y los cambios de plantilla y parámetros.
- Límite diario por empleado (10 por omisión); vista previa del administrador con datos ficticios y marca de agua, que no se registra como emisión.
- **Firmantes** (`certificate_signers`): el administrador designa a la persona por su identificación, con el cargo que aparece bajo la firma y un nivel: PRINCIPAL o RESPALDO. Designar le da el rol `CERTIFICATE_APPROVER` (alcance de la empresa). La propia persona carga la imagen de su firma y **autoriza su uso** desde «Mi firma de certificados» (confirmación de clave); nadie más la carga ni la ve, ni siquiera el administrador. Queda registrado cuándo, con qué huella y con qué consentimiento.
- **Quién firma cada certificado:** pueden firmar los designados activos con cuenta activa, rol vigente y firma cargada. Firman los PRINCIPAL; solo si no hay ninguno disponible, los de RESPALDO (el gerente general «en su defecto»). Con más de un principal el empleado elige quién firma (por omisión, el primero). Sin ningún firmante disponible no se genera el certificado.
- El PDF lleva la imagen de la firma, el nombre y el cargo. El historial conserva quién firmó, su cargo y la huella de la firma aplicada.
- Pendiente como mejora: firma digital criptográfica y código público de validación (SSD 6.1); la imagen de la firma no demuestra por sí sola la aprobación (SSD 6.1.2).

## Consecuencias

- No hay control previo de un aprobador sobre cada emisión: el contenido lo gobierna el administrador (plantilla), los datos vienen de `EMPLEADOS` y la firma se aplica automáticamente por haber sido autorizada de antemano por su titular. Un dato erróneo en `EMPLEADOS` produce un certificado erróneo con firma.
- Sin firma digital criptográfica ni código público de validación, el documento no es verificable por terceros más allá del código del formato, la referencia y el historial.
- La ciudad de emisión y el pie llevan valores por omisión (Barranquilla, sin datos) hasta que el administrador los configure.
