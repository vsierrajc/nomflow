# Sesión 2026-09-30: política de retención de datos (ESS-RET-001)

Rama `feat/ESS-RET-politica-retencion`.

## Decisiones del usuario

- Certificados de retención: se conservan mientras la persona esté activa y se descargan al desactivarse (ZIP de baja). Nunca se purgan automáticamente; solo borrado manual del administrador, con confirmación, tras la baja. El borrado advierte (no bloquea) si el ZIP nunca se descargó.
- Auditoría de peticiones: 365 días (ya cubierta por la política de Registros).
- Valores iniciales: sesiones 30, códigos 30, filas de importación 90 días; depuración automática desactivada.

## Hecho

- Migración `0034_politica_retencion.sql` (`data_retention_settings`), `DataRetentionService`, monitor diario y endpoints `admin/data-retention`.
- `delete()` en los almacenes cifrado y por niveles.
- Borrado manual de certificados (`DELETE admin/data-retention/certificates/:nIde`) con auditoría `TAX_CERTIFICATES_DELETE`.
- Página `/admin/retencion` y pruebas (API y navegador).

## Pendiente

- Activar `auto_enabled` en producción solo con respaldo previo y aprobación.
