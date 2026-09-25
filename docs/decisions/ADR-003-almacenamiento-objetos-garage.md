# ADR-003: Almacenamiento de objetos con Garage (reemplaza a MinIO)

- Estado: Aceptada (2026-09-24)
- Reemplaza: la referencia a «almacenamiento privado compatible con S3» de ADR-001, que en el código nunca se llegó a usar.

## Contexto
MinIO está deprecado y se decidió reemplazarlo por **Garage** (GarageHQ), un almacén de objetos con API compatible con S3. Hasta hoy ningún módulo usaba MinIO: los documentos se guardaban como `bytea` en PostgreSQL (certificados de retención, logos, soportes de permisos) o no se guardaban (volantes: se generan en cada descarga; solicitudes de vacaciones: no producían documento).

## Qué va a almacenamiento de objetos (y qué no)
| Elemento | Decisión |
| --- | --- |
| Certificados de retención | **Almacenamiento de objetos** (antes `bytea`). |
| Solicitudes de vacaciones | **Almacenamiento de objetos**: la constancia PDF de la solicitud aprobada. |
| Permisos | **Solo base de datos**: son registros; su soporte adjunto sigue en la base. |
| Volantes de pago | **No se guardan**: se generan y quedan disponibles para descarga. |
| Logos de empresa | Sin cambio (base de datos). |

## Decisión
1. **Garage v2** (imagen fijada) como servicio del stack local, en un nodo con `replication_factor = 1`. Datos y metadatos en **volúmenes con nombre** (`garage-meta`, `garage-data`). Los secretos (`rpc_secret`, token de administración) viajan por variables de entorno, no en el archivo de configuración.
2. **Cliente:** `@aws-sdk/client-s3` con `forcePathStyle` y región `garage`; la aplicación no depende de Garage en concreto, sino de la API S3.
3. **Cifrado en la aplicación.** Garage acepta el encabezado de cifrado `SSE-S3` pero **no cifra** (se verificó: responde «aceptado» y guarda en claro). Por eso cada objeto se cifra con AES-256-GCM antes de subirlo, con la clave de objeto ligada a su nombre (AAD) para que no se pueda intercambiar un objeto por otro. La clave sale de `OBJECT_ENCRYPTION_KEY` o, si falta, de `SESSION_SECRET`.
4. **Integridad:** la base guarda el `sha256` del documento en claro y se comprueba en cada descarga.
5. **Acceso siempre por la API:** no hay URLs públicas ni prefirmadas; la API autoriza y entrega el archivo.
6. **Nombres de objeto sin datos personales:** `tax-certificates/<uuid>.pdf`, `vacation-requests/<uuid>/rev-<n>.pdf`.
7. **Arranque idempotente** (`scripts/garage-init.sh`): asigna el diseño del nodo, crea el bucket, importa la clave de la aplicación y le da permisos. Se ejecuta en `stack:up` y en el CI.
8. **Sin configuración, no hay almacenamiento:** si faltan las variables `S3_*`, las funciones que necesitan documentos responden 503; nunca se cae en silencio a memoria o a disco.

## Plan de implementación
1. Infra: servicio Garage en `docker-compose.yml`, `docker/garage/garage.toml`, `scripts/garage-init.sh`, variables en `.env` (generadas por `stack.sh`), retiro de MinIO.
2. Módulo `storage` en la API: interfaz `ObjectStore`, implementación S3, cifrado, almacén en memoria para pruebas.
3. Certificados de retención: subir a objetos; migración `0022` (`object_key`, `data` opcional); comando `storage:migrate` para pasar los existentes; los antiguos siguen descargándose mientras tanto.
4. Constancia de vacaciones: PDF al aprobar (con generación diferida si falla), tabla `vacation_documents`, descarga por el empleado, su jefe y el aprobador final de la empresa.
5. Pruebas: unitarias del cifrado, integración contra Garage real (se omiten sin servicio), API con almacén en memoria, navegador contra Garage.
6. CI: levantar Garage en el job de navegador y ejecutar la integración real.
7. Documentación: README, `docs/local-stack.md`, HANDOFF, STATUS, CHANGELOG, trazabilidad.

## Consecuencias
- Garage no ofrece cifrado en reposo propio: la protección depende de la clave de objeto de la aplicación. **Perder o rotar `OBJECT_ENCRYPTION_KEY` sin re-cifrar deja los documentos ilegibles**; la rotación queda como tarea pendiente.
- El SDK de AWS dejará de dar soporte a Node 20 a partir de enero de 2027: hay que subir a Node 22 antes.
- Un nodo con `replication_factor = 1` no tiene redundancia: en producción hacen falta respaldos del volumen o más nodos.
- El volumen `minio-data` del stack anterior queda sin uso; puede eliminarse a mano (`docker volume rm nomflow_minio-data`), no lo hace ningún script.

## Reversión
Los documentos antiguos en `bytea` se conservan hasta ejecutar `storage:migrate`; hasta entonces basta volver a la versión anterior. Después de migrar, revertir exige exportar los objetos a la base.
