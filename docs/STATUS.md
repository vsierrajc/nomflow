# Estado del proyecto NOMFLOW

- Versión: 0.0.0 (pre-lanzamiento; sin despliegue en producción). Actualizado el 29 de septiembre de 2026.
- **Plan por fases: [PLAN.md](PLAN.md)**. Traspaso para la próxima sesión: [HANDOFF.md](HANDOFF.md). Última bitácora: [sessions/2026-09-29-turnos-dias-habiles.md](sessions/2026-09-29-turnos-dias-habiles.md).
- `main` contiene los PR #1 a #88 integrados; no hay PR abiertos.
- Revisión por otra persona: el usuario revisó y aprobó la integración de los PR #85-#88; `main` sigue sin protección de rama (la SSD, sección 11, la exige formalmente).
- Pruebas: 436 de API y unas 115 de navegador en verde; CI completo (CodeQL, secretos, e2e) sin alertas abiertas. Ver [README](../README.md).

| módulo | estado | PR | siguiente acción |
| --- | --- | --- | --- |
| Monorepo, CI y ADR-001/002 (ESS-OPS-001) | DONE | #1, #2 | Job e2e obligatorio; protección de `main` |
| Cuentas, login, sesiones, clave asignada y doble paso (ESS-AUTH-001/003) | DONE; límite de peticiones por IP en los endpoints públicos (`AUTH_RATE_LIMIT_MAX`/`_WINDOW_MS`) y `TRUST_PROXY` para leer la IP real detrás de un proxy | #3-#5, #36, #51, #52, #60, #90 | - |
| Verificación SMTP y activación (ESS-AUTH-002) | DONE | #6 | STARTTLS en el servidor interno |
| Alta por API, roles y reautenticación opcional (ESS-AUTH-004/005/006) | DONE | #7, #11, #55 | Revisión de otra persona |
| Importación de EMPLEADOS (ESS-IMPORT-002) | DONE | #8, #47 | Datos ya cargados desde `initconfigdata` |
| Empresas, catálogos y logo (ESS-ORG-001) | DONE | #9, #17, #63 | Logo de GA cargado; encabezado y pie en imagen disponibles |
| Roles con alcance, jefes y directores de área (ESS-ORG-002) | DONE | #10, #53, #68 | Asignar director por área y gerente general; suplencias |
| Stack local, Graphify, scripts de inicio y pruebas de navegador | DONE | #12, #13, #15, #38 | - |
| Acceso web y menús (ESS-WEB-001) | DONE | #14, #46, #56, #58, #73 | - |
| Volantes de pago PDF (ESS-PAY-001) | DONE; diseño carta según el modelo; carga por PER/N_LIQ del archivo; retiro de publicación con motivo y auditoría | #16, #74-#76, #86 | Cargar `nomina.xlsx` real |
| Módulo administrativo, API e interfaz (ESS-ADM-001/002) | DONE | #17, #18, #39, #64, #70, #72 | - |
| Rediseño de la interfaz (ESS-UX-001) | DONE | #19, #54, #66, #71; conmutador de tema y pruebas del árbol de accesibilidad en revisión (`feat/ESS-UX-tema-manual-lectores`) | Revisión manual con lectores de pantalla reales y otros navegadores |
| Certificados de retención (ESS-TAX-001) | DONE (carpeta y carga desde el navegador) | #22, #69 | - |
| Política de retención de datos (ESS-RET-001) | DONE; sesiones, códigos, filas de importación y ZIP caducados; certificados solo con borrado manual tras la baja | #91 | Activar `auto_enabled` en producción con respaldo previo |
| Vacaciones: `PROG_VAC`, festivos, solicitud y aprobaciones (ESS-LEAVE-001/002/003, ESS-HOL-001) | DONE; aprobación jerárquica jefe > director > gerente > aprobación final; constancia PDF con las firmas de quienes aprobaron (en revisión, `feat/ESS-LEAVE-003-constancia-firmas`) | #26, #28, #29, #33, #34, #61, #62, #65, #67 | Corrección de disfrutes, suplencias |
| Turnos y días hábiles de vacaciones (ESS-LEAVE-004) | DONE; catálogo de turnos (`/admin/turnos`), cálculo de días hábiles y retorno según el turno del empleado, bloquea con `SHIFT_MISSING` si falta el turno | #87 | - |
| Permisos (ESS-PERM-001) | DONE (decide solo el jefe de área) | #30 | Reglas por tipo |
| Cambio de correo por resolución administrativa (ESS-EMP-002) | DONE; exige nueva verificación del correo y revoca sesiones; la importación conserva una corrección manual | #88 | - |
| Correo saliente configurable | DONE | #35 | STARTTLS |
| Almacenamiento de objetos con Garage (ADR-003) | DONE | #40, #41 | Custodia y rotación de `OBJECT_ENCRYPTION_KEY` |
| Salud del sistema y alertas | DONE | #42 | CPU/memoria, otros canales |
| Archivo histórico en la nube (ADR-004) | DONE (conexión verificada; falta enviar datos reales) | #43, #50 | Primera prueba real de «Enviar al histórico» |
| Bandeja de entrada y avisos por correo del flujo | DONE | #48 | - |
| Certificado laboral de autoservicio (ADR-005), firma imagen y digital, encabezado y pie en imagen; el empleado quita certificados de su bandeja y el administrador los conserva y filtra | DONE | #49, #57, #63 | Firmas de los tres firmantes; ciudad, pie y código de formato |
| Gestión de registros (ADR-006) | DONE | #58, #59 | Prueba real contra el bucket; política automática |
| Aviso de baja y ZIP (ESS-EXIT-001) | DONE; aviso previo configurable (`PRE_BAJA_AVISO_DIAS`), exportación ZIP asíncrona, incumplimiento auditado | #85 | - |
| Despliegue en producción (ESS-OPS-001) | BACKLOG | - | Fase 4 del plan |

## Bloqueos y decisiones abiertas
- Cargar la nómina real (`nomina.xlsx`) y `PROG_VAC`: dependen de aprobación explícita (escriben datos reales).
- Asignar el director de cada área y el gerente general; definir quién aprueba las vacaciones de quien tiene la aprobación final.
- Firmantes del certificado laboral: solo la Directora de Gestión Humana tiene firma cargada.
- Plazos definitivos de retención (valores iniciales: sesiones 30, códigos 30, filas de importación 90 días, auditoría 365) y activación de la depuración automática en producción.
- Sección 12 de la SSD: baja y conservación de documentos, códigos de `EST` y fecha de corte de `PROG_VAC`, credencial y región de la API de festivos, evidencia de firma.
- El servidor de correo interno no tiene TLS: los códigos viajan sin cifrar dentro de la red.

## Entorno de desarrollo
- Base de desarrollo `nomflow` y de pruebas `nomflow_test` (las pruebas vacían las tablas: exportar siempre `DATABASE_URL=.../nomflow_test`).
- Stack local: `./iniciar_app.sh` y `./detener_app.sh` (ver [local-stack](local-stack.md)).
