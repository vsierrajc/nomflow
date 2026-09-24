# Matriz de trazabilidad

Estados: BACKLOG, READY, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE.

| ID | Requisito (SSD) | Fase | Incidencia | PR/commit | Pruebas | Versión | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ESS-AUTH-001 | Alta administrativa, clave temporal Argon2id, cambio obligatorio (3.1) | 1 | — | — | — | — | BACKLOG |
| ESS-AUTH-002 | Verificación de correo por secreto de un solo uso vía SMTP (3.1) | 1 | — | — | — | — | BACKLOG |
| ESS-AUTH-003 | Login, sesiones revocables, CSRF, reautenticación (3.1) | 1 | — | — | — | — | BACKLOG |
| ESS-AUTH-004 | Roles con alcance y vigencia; autorización por N_IDE (3.1, 5) | 1 | — | PR #7 y ESS-ORG-002 | admin-accounts.e2e.spec.ts, org.e2e.spec.ts | — | IN_REVIEW |
| ESS-AUD-001 | Auditoría sin datos sensibles (3.2, 5) | 1 | — | — | — | — | BACKLOG |
| ESS-ORG-001 | CRUD Company/Area/CostCenter/JobPosition/ContractType, jefes con vigencia (9.6) | 2 | — | PR ESS-ORG-001 | catalogs.e2e.spec.ts | — | IN_REVIEW (parcial: empresas CRUD e importación; faltan CRUD de entradas y jefes) |
| ESS-IMPORT-001 | Importación Excel por lotes, staging, idempotencia, reversión (9.2-9.3) | 2 | — | — | — | — | BLOCKED (datos origen) |
| ESS-IMPORT-002 | Importación EMPLEADOS con EST V/C y contrato único vigente (9.1) | 2 | — | PR ESS-IMPORT-002 | imports.e2e.spec.ts | — | IN_REVIEW (datos reales aún con EST=A) |
| ESS-PAY-001 | Volantes PDF, SLRIO histórico, modos SIN_AJUSTE/ENTERO_SUPERIOR (9.2, 9.4) | 3 | — | — | — | — | BACKLOG |
| ESS-CERT-001 | Plantillas de certificado versionadas (6.1.1) | 3 | — | — | — | — | BACKLOG |
| ESS-CERT-002 | Certificado laboral: aprobación, firma, código de validación (6.1, 6.1.2) | 3 | — | — | — | — | BACKLOG |
| ESS-TAX-001 | Certificados tributarios PDF por N_IDE+año (6.3) | 3 | — | — | — | — | BACKLOG |
| ESS-EXIT-001 | Aviso previo a baja, ZIP, revocación con EST=C (3.1, 6.3) | 3 | — | — | — | — | BACKLOG |
| ESS-LEAVE-001 | PROG_VAC: carga y CRUD, DISP, LIQUIDADA (6.2) | 4 | — | — | — | — | BACKLOG |
| ESS-LEAVE-002 | Solicitud multi-período, cálculo de fechas y retorno (6.2) | 4 | — | — | — | — | BACKLOG |
| ESS-LEAVE-003 | Revisiones, aprobación jefe y final, VACACIONES, PDF con firmas (6.2) | 4 | — | — | — | — | BACKLOG |
| ESS-HOL-001 | Calendario de festivos: API, Excel, CRUD, respaldo local (6.2.1) | 4 | — | — | — | — | BACKLOG |
| ESS-PERM-001 | Permisos por tipo, sin consumir DISP (6.2) | 4 | — | — | — | — | BACKLOG |
| ESS-OPS-001 | Endurecimiento, respaldo/restauración, despliegue, monitoreo (8, 11) | 5 | — | — | — | — | BACKLOG |
| ESS-ORG-002 | Asignación de jefe de área con vigencia e historial (5, 9.1) | 2 | — | PR ESS-ORG-002 | org.e2e.spec.ts | — | IN_REVIEW |
| ESS-AUTH-006 | Cambio de clave por el propio usuario (3.1) | 1 | — | PR ESS-AUTH-006 | change-password.e2e.spec.ts | — | IN_REVIEW |
| ESS-WEB-001 | Pantallas de acceso: ingreso, activación, cambio de clave, inicio | 1 | — | PR ESS-WEB-001 | profile.e2e.spec.ts (API); UI verificada manualmente vía proxy | — | IN_REVIEW |
