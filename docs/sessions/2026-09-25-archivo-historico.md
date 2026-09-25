# 2026-09-25: archivo histórico en la nube

- Petición: transferir lo histórico a un bucket de Google para liberar espacio local, manteniendo lo reciente en local y lo histórico consultable. Decisiones: 1 año; local hasta verificar la copia; consulta transparente con aviso; EE. UU. `us-central1`, bucket `nomflow`.
- Implementado: ADR-004, `TieredObjectStore`, `ArchiveService` (copiar, verificar sha256, liberar local), monitor diario, `/admin/archivo`, tablas `archive_settings` y `archived_objects` (migración 0024), avisos de demora en retenciones y vacaciones, comprobación en Salud del sistema.
- Pruebas: 7 de API con almacenes simulados (copia, verificación, corrupción, gracia, nube caída, permisos, secreto), 2 de navegador. Sin probar aún contra Google real.
- Pendiente: el usuario crea la clave HMAC y la guarda en /admin/archivo; primera ejecución real y comprobación de descarga histórica; considerar caché local de lo descargado.
