# Matriz de trazabilidad

Actualizada el 26 de septiembre de 2026. Estados: BACKLOG, READY, IN_PROGRESS, IN_REVIEW, BLOCKED, PARCIAL, DONE. El plan por fases está en [PLAN.md](PLAN.md).

| ID | Requisito (SSD) | Fase SSD | PR | Pruebas | Estado |
| --- | --- | --- | --- | --- | --- |
| ESS-AUTH-001 | Alta administrativa, clave temporal Argon2id, cambio obligatorio; restablecer y mostrar la clave asignada (3.1) | 1 | #7, #36, #51, #52 | admin-accounts.e2e.spec.ts, e2e/admin-gestion.spec.ts | DONE |
| ESS-AUTH-002 | Verificación de correo por secreto de un solo uso vía SMTP (3.1) | 1 | #6 | e2e/acceso.spec.ts, e2e/correo.spec.ts | DONE (falta STARTTLS del servidor interno) |
| ESS-AUTH-003 | Login, sesiones revocables, CSRF, reautenticación opcional, doble paso opcional por correo o app autenticadora (TOTP con QR y códigos de respaldo), sesión caducada, límite de peticiones por IP (3.1) | 1 | #3-#5, #36, #55, #60, #90, #99 | auth e2e, totp.e2e.spec.ts, totp-login.e2e.spec.ts, e2e/doble-paso.spec.ts, e2e/doble-paso-totp.spec.ts, e2e/sesion-expirada.spec.ts, ip-rate-limit.e2e.spec.ts | DONE |
| ESS-AUTH-004 | Roles con alcance y vigencia; autorización por N_IDE (3.1, 5) | 1 | #7, #10, #53, #67 | org.e2e.spec.ts, admin-access.e2e.spec.ts | DONE (roles AREA_DIRECTOR y GENERAL_MANAGER incluidos) |
| ESS-AUTH-006 | Cambio de clave por el propio usuario (3.1) | 1 | #5 | change-password.e2e.spec.ts | DONE |
| ESS-AUD-001 | Auditoría sin datos sensibles (3.2, 5) | 1 | #17 | audit e2e | DONE (falta correlacionar con eventos de negocio) |
| ESS-ORG-001 | CRUD de Company/Area/CostCenter/JobPosition/ContractType (9.6) | 2 | #9, #17, #47, #63, #68 | catalogs.e2e.spec.ts, logos.e2e.spec.ts, letterhead.e2e.spec.ts | DONE |
| ESS-ORG-002 | Jefe y director de área con vigencia e historial (5, 9.1) | 2 | #10, #68 | org.e2e.spec.ts, vacation.e2e.spec.ts, permit.e2e.spec.ts, e2e/suplencias.spec.ts | DONE (suplencias: titular designa, Gestión Humana anula) |
| ESS-IMPORT-001 | Importación Excel por lotes, staging, idempotencia, reversión (9.2-9.3) | 2 | #8, #16, #75 | imports.e2e.spec.ts, payroll.e2e.spec.ts | DONE |
| ESS-IMPORT-002 | Importación EMPLEADOS con EST V/C y contrato único vigente (9.1) | 2 | #8, #47 | imports.e2e.spec.ts | DONE (datos reales cargados) |
| ESS-EMP-002 | Cambio de correo por resolución administrativa; la importación conserva una corrección manual (9.3) | 2 | #88 | employees.e2e.spec.ts, imports.e2e.spec.ts | DONE |
| ESS-PAY-001 | Volantes PDF carta según el modelo, SLRIO por liquidación, modos SIN_AJUSTE/ENTERO_SUPERIOR, carga por PER y N_LIQ, retiro de publicación con motivo y auditoría (9.2, 9.4, 9.6) | 3 | #16, #74, #75, #76, #86 | payroll.e2e.spec.ts, number-words.spec.ts, e2e/volantes.spec.ts | DONE (falta cargar `nomina.xlsx` real) |
| ESS-TAX-001 | Certificados tributarios PDF por N_IDE+año, por carpeta y desde el navegador (6.3) | 3 | #22, #69 | tax.e2e.spec.ts, e2e/retenciones.spec.ts | DONE; se conservan mientras la persona esté activa y solo se borran a mano tras la baja (ESS-RET-001) |
| ESS-CERT-001 | Plantillas de certificado versionadas (6.1.1) | 3 | #49 | labor-cert.e2e.spec.ts, template-engine.spec.ts | DONE |
| ESS-CERT-002 | Certificado laboral: firmantes designados, firma imagen y digital, código de formato, historial con búsqueda por empleado, el empleado puede quitarlos de su bandeja (el administrador los conserva), encabezado y pie en imagen (6.1, 6.1.2) | 3 | #49, #57, #63, #64 | labor-cert.e2e.spec.ts, digital-signature.spec.ts, e2e/certificado-laboral.spec.ts | DONE (falta validación pública, sellado de tiempo y firmas de los firmantes) |
| ESS-EXIT-001 | Aviso previo a baja, ZIP, revocación con EST=C (3.1, 6.3) | 3 | #85 | exit.e2e.spec.ts, bajas.spec.ts, mi-baja.spec.ts | DONE |
| ESS-LEAVE-001 | PROG_VAC: carga y CRUD, DISP, LIQUIDADA (6.2) | 4 | #26, #61, #62 | leave.e2e.spec.ts, prog-vac.import.e2e.spec.ts, e2e/vacaciones.spec.ts | DONE |
| ESS-LEAVE-002 | Solicitud multi-período, cálculo de fechas y retorno (6.2) | 4 | #28, #65 | business-days.spec.ts, e2e/vacaciones-solicitud.spec.ts | DONE (falta corrección de disfrutes) |
| ESS-LEAVE-003 | Revisiones, aprobación jerárquica (jefe, director, gerente general), aprobación final, VACACIONES, constancia PDF (6.2) | 4 | #29, #33, #34, #67 | vacation.e2e.spec.ts, e2e/vacaciones-solicitud.spec.ts, e2e/firma-aprobador.spec.ts | PARCIAL (constancia con las firmas hecha; faltan las suplencias) |
| ESS-HOL-001 | Calendario de festivos: API, Excel, CRUD, respaldo local (6.2.1) | 4 | #28 | holiday-api.e2e.spec.ts, e2e/vacaciones.spec.ts | PARCIAL (falta reintento y credencial/región definitivas) |
| ESS-LEAVE-004 | Catálogo de turnos y cálculo de días hábiles/retorno según el turno del empleado (6.2) | 4 | #87 | business-days.spec.ts, vacation.e2e.spec.ts, leave.e2e.spec.ts, holiday-api.e2e.spec.ts | DONE (turnos reales 01/02/03 confirmados) |
| ESS-PERM-001 | Permisos por tipo, sin consumir DISP (6.2) | 4 | #30 | permit.e2e.spec.ts, e2e/permisos.spec.ts | DONE (decide solo el jefe de área; faltan reglas por tipo) |
| ESS-WEB-001 | Pantallas de acceso: ingreso, activación, cambio de clave, inicio, menús | 1 | #14, #46, #56, #58, #71, #73 | e2e/acceso.spec.ts, e2e/interfaz.spec.ts | DONE |
| ESS-ADM-001 | Módulo administrativo: catálogos, conceptos, logo, empleados, cuentas, auditoría (5, 9.6, 3.2) | 2 | #17, #39 | concepts/logos/catalog-crud/employees/admin-support/admin-access/audit e2e | DONE |
| ESS-ADM-002 | Interfaz web del módulo administrativo, solo administradores (9.6, 3.1) | 2 | #18, #64, #70, #72 | e2e/admin.spec.ts, e2e/admin-gestion.spec.ts | DONE |
| ESS-UX-001 | Rediseño profesional de la interfaz (accesibilidad, contraste, móvil, estados) | 1-2 | #19, #54, #66, #71 | e2e/interfaz.spec.ts, acceso.spec.ts, volantes.spec.ts | DONE |
| ESS-NOTIF-001 | Bandeja de entrada y avisos por correo del flujo, recordatorio a los 3 días | 4 | #48 | inbox e2e, e2e/bandeja.spec.ts, e2e/notificaciones.spec.ts | DONE |
| ESS-STORE-001 | Almacenamiento de objetos cifrado en Garage (ADR-003) | 5 | #40, #41 | storage e2e | DONE (falta custodia y rotación de la clave) |
| ESS-ARCH-001 | Archivo histórico en la nube, descarga transparente (ADR-004) | 5 | #43, #50 | archive.e2e.spec.ts, e2e/archivo.spec.ts | DONE (falta prueba real contra el bucket) |
| ESS-HEALTH-001 | Salud del sistema y alertas configurables | 5 | #42 | health e2e, e2e/salud.spec.ts | DONE |
| ESS-LOG-001 | Gestión de registros: ver, exportar, histórico en la nube, depurar y vaciar (ADR-006) | 5 | #58, #59 | logs.e2e.spec.ts, e2e/registros.spec.ts | DONE |
| ESS-RET-001 | Política de retención de datos operativos y borrado manual de certificados tras la baja (SSD 12) | 1 | en revisión | data-retention.e2e.spec.ts, e2e/retencion.spec.ts | DONE |
| ESS-OPS-001 | Endurecimiento, respaldo/restauración, despliegue, monitoreo (8, 11) | 5 | #1, #2, #12, #38 | - | PARCIAL (CI y stack local; faltan imágenes, despliegue, restauración probada y monitoreo de servidor) |
