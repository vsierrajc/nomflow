# Matriz de trazabilidad

Estados: BACKLOG, READY, IN_PROGRESS, IN_REVIEW, BLOCKED, DONE.

| ID | Requisito (SSD) | Fase | Incidencia | PR/commit | Pruebas | Versión | Estado |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ESS-AUTH-001 | Alta administrativa, clave temporal Argon2id, cambio obligatorio (3.1) | 1 | — | — | — | — | BACKLOG |
| ESS-AUTH-002 | Verificación de correo por secreto de un solo uso vía SMTP (3.1) | 1 | — | — | — | — | BACKLOG |
| ESS-AUTH-003 | Login, sesiones revocables, CSRF, reautenticación (3.1) | 1 | — | — | — | — | BACKLOG |
| ESS-AUTH-004 | Roles con alcance y vigencia; autorización por N_IDE (3.1, 5) | 1 | — | — | — | — | BACKLOG |
| ESS-AUD-001 | Auditoría sin datos sensibles (3.2, 5) | 1 | — | — | — | — | BACKLOG |
| ESS-ORG-001 | CRUD Company/Area/CostCenter/JobPosition/ContractType, jefes con vigencia (9.6) | 2 | — | — | — | — | BACKLOG |
| ESS-IMPORT-001 | Importación Excel por lotes, staging, idempotencia, reversión (9.2-9.3) | 2 | — | — | — | — | BLOCKED (datos origen) |
| ESS-IMPORT-002 | Importación EMPLEADOS con EST V/C y contrato único vigente (9.1) | 2 | — | — | — | — | BLOCKED (EST=A) |
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
