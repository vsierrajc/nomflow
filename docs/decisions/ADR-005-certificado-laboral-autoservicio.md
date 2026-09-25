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
- **Firma digital criptográfica (opcional, en paralelo a la imagen).** Cada firmante puede, además de la imagen, tener una firma digital: PDF con campo de firma `adbe.pkcs7.detached` (PKCS#7 detached, SHA-256, RSA ≥ 2048), aplicada al emitir con el certificado del firmante. Dos formas de tenerla: subir su propio `.p12/.pfx` con su clave (de una entidad de certificación acreditada) o pedir a NOMFLOW un **certificado autofirmado** de pruebas (RSA 2048, 2 años; no lo respalda ninguna entidad de certificación). Al cargarla se comprueba que la clave abre, que corresponde al certificado, que no está vencida y que sirve para firmar (firma de prueba). Requiere la autorización expresa de su titular.
- Modos: `IMAGEN`, `DIGITAL` o `IMAGEN+DIGITAL`; el PDF que se guarda es ya el firmado (su sha256 es el del archivo firmado). Un certificado digital vencido o retirado deja de firmar. El administrador puede **exigir firma digital** (solo firman quienes la tengan).
- **Verificación:** el administrador (historial) y el empleado (sus certificados) pueden verificar un documento: huella del archivo guardado, integridad de lo firmado (digest SHA-256 sobre el `ByteRange`), firma RSA con el certificado incluido, que cubre todo el archivo y que el certificado es el registrado al emitir. La verificación se contrasta en las pruebas con OpenSSL. NOMFLOW no valida la cadena de confianza ni la revocación: un autofirmado se marca como tal.
- **Gestión de claves:** el `.p12` y su clave se guardan cifrados (AES-256-GCM) con la clave de ajustes del sistema (`SETTINGS_ENCRYPTION_KEY`, o `SESSION_SECRET` si falta). Como el servidor firma sin intervención de la persona (autoservicio), quien controle el servidor y esa clave puede firmar en nombre del firmante: para producción con validez legal se recomienda un HSM o servicio de firma de la entidad de certificación, que queda como mejora. Cambiar la clave de ajustes deja inservibles los certificados guardados (habría que recargarlos).
- Pendiente como mejora: código público de validación, sellado de tiempo (TSA), validación de la cadena y revocación, y firma remota/HSM.

## Consecuencias

- No hay control previo de un aprobador sobre cada emisión: el contenido lo gobierna el administrador (plantilla), los datos vienen de `EMPLEADOS` y la firma se aplica automáticamente por haber sido autorizada de antemano por su titular. Un dato erróneo en `EMPLEADOS` produce un certificado erróneo con firma.
- Sin código público de validación, terceros verifican el documento con su lector de PDF (firma digital) y no contra un registro de NOMFLOW. Un certificado autofirmado no es reconocido por terceros como confiable.
- La ciudad de emisión y el pie llevan valores por omisión (Barranquilla, sin datos) hasta que el administrador los configure.
