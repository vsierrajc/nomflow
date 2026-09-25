# ADR-004: Archivo histórico en la nube (Google Cloud Storage)

- Estado: aceptada (2026-09-25). Depende de [ADR-003](ADR-003-almacenamiento-objetos-garage.md).

## Contexto

Garage guarda en local los certificados de retención y las constancias de vacaciones. Con los años ocupan espacio que se quiere liberar sin perder acceso: lo reciente debe responder rápido en local y lo histórico debe seguir consultable desde la nube.

## Decisiones (del usuario)

1. **Edad para archivar: un año** (configurable, mínimo 30 días).
2. **Mientras un objeto no esté verificado en la nube, permanece en local.** Solo se borra de Garage tras releer la copia de la nube y comprobar su sha256. Días de gracia opcionales (por omisión 0).
3. **Consulta transparente**: si el objeto no está en local, la descarga lo trae de la nube; la interfaz avisa de que puede tardar unos segundos.
4. **Google Cloud Storage, EE. UU., región `us-central1`, bucket `nomflow`**, por su API S3 interoperable con clave HMAC.

## Diseño

- `TieredObjectStore` (por debajo del cifrado): escribe en Garage; al leer, si no está en local consulta la nube. Si no está en local y la nube no responde, falla como no disponible (503): no se afirma «no existe».
- En la nube solo hay bytes ya cifrados con `OBJECT_ENCRYPTION_KEY`, que nunca sale del servidor. Los nombres de objeto no llevan datos personales.
- Tablas: `archive_settings` (una fila; el secreto HMAC cifrado con la clave de ajustes) y `archived_objects` (`BOTH` = copia verificada y aún en local; `CLOUD` = solo en la nube, con sha256 y tamaño).
- Archivado (`ArchiveService.run`): candidatos = certificados y constancias con más de N días que no estén en `archived_objects` (lotes de 200). Por cada uno: leer de local, subir, releer de la nube y comparar sha256; registrar `BOTH`. Después, los `BOTH` con la gracia cumplida se verifican otra vez en la nube y se borran de local (`CLOUD`). Un fallo en un objeto no detiene los demás; una copia que no coincide nunca se acepta ni se borra el original.
- Automático: cada hora se revisa si toca (activado y sin ejecución en 20 h); `ARCHIVE_SCHEDULER=off` lo desactiva. Manual: «Archivar ahora».
- Administración (`/admin/archivo`): configuración, probar conexión (escribe, lee y borra un objeto de prueba), estado y última ejecución. Salud del sistema añade la comprobación «Archivo histórico» (aviso si la última ejecución falló o lleva más de 3 días sin correr).
- Los listados de certificados y solicitudes de vacaciones devuelven `archived` / `documentArchived` para mostrar el aviso de demora.
- El cliente S3 desactiva las sumas de verificación automáticas del SDK (`WHEN_REQUIRED`), que Google rechaza.

## Consecuencias

- Lo histórico depende de internet y de Google; sin conexión esos documentos responden 503 hasta que vuelva. Lo reciente no se afecta.
- Perder `OBJECT_ENCRYPTION_KEY` deja ilegible también lo archivado; su respaldo ([docs/backup-clave-objetos.md](../backup-clave-objetos.md)) es más importante aún.
- Hay costo de almacenamiento y de salida de datos de Google (las descargas históricas).
- Los datos salen de la red del cliente, cifrados. La transferencia internacional (Ley 1581) queda a cargo del responsable del tratamiento; el usuario eligió EE. UU./us-central1.
- No se devuelve a local lo descargado de la nube (sin caché); si se vuelve frecuente se puede añadir.

## Reversión

Desactivar el archivado detiene nuevas copias; lo ya archivado sigue consultable. Para volver todo a local basta copiar los objetos `CLOUD` de vuelta a Garage con el mismo nombre (los bytes son idénticos) y borrar sus filas de `archived_objects`.
