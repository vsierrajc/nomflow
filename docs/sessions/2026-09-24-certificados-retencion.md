# Sesión: 2026-09-24 - certificados de retención
- Responsable / agente: Claude Code
- Objetivo e incidencias: ESS-TAX-001
- Rama: feat/ESS-TAX-001-certificados-retencion desde main
- Cambios realizados: tabla `tax_certificates` (migración 0015, PDF en `bytea` como los logos), servicio y controladores `/me/tax-certificates` y `/admin/tax-certificates` (listar, procesar con reautenticación), páginas `/retenciones` y `/admin/retenciones`, variable `TAX_CERT_INBOX_DIR`, `/data/` y `*.pdf` ignorados por Git
- Decisiones: almacenamiento en la base (ADR pendiente de migrar a S3 con los demás documentos); una versión vigente por empleado y año, mismo hash = sin cambios; los errores transitorios dejan el archivo en la carpeta
- Pruebas y evidencia: 220 pruebas de API (5 nuevas: nombre, carga y rechazos, versionado, aislamiento del empleado, acceso administrativo); format, lint, typecheck, build y audit en verde
- Bloqueos y riesgos: sin prueba de navegador aún; los PDF reales contienen datos personales (carpeta fuera de Git)
- Estado final: hecho
- Próximo paso: ESS-EXIT-001 (aviso de baja y ZIP), según HANDOFF §4
