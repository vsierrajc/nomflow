# Estado del proyecto NOMFLOW

- Versión: 0.0.0 (pre-lanzamiento; sin despliegue en producción)
- **Traspaso para la próxima sesión: [HANDOFF.md](HANDOFF.md)** (pendientes, próximos pasos y trampas conocidas).
- Última bitácora: [2026-09-24-doble-paso](sessions/2026-09-24-doble-paso.md)
- `main` contiene los PR #1 a #35 integrados; el PR #36 (clave asignada y doble paso) se integra con esta actualización.
- Revisión por otra persona: ninguno de los PR fue revisado por alguien distinto del autor y `main` no tiene protección de rama (la SSD, sección 11, la exige).
- Pruebas: 292 de API y 97 de navegador en verde; CI completo (incluido CodeQL) sin alertas abiertas. Ver [README](../README.md) para la visión general.

| módulo | estado | PR | siguiente acción |
| --- | --- | --- | --- |
| Monorepo, CI y ADR-001/002 (ESS-OPS-001) | DONE | #1, #2 | CodeQL sube a Code scanning (repositorio público) y el job falla si hay hallazgos |
| Cuentas, login y sesiones (ESS-AUTH-001/003) | DONE | #3, #4, #5, #36 | Límite por IP en los endpoints públicos |
| Verificación SMTP y activación (ESS-AUTH-002) | DONE | #6 | Habilitar STARTTLS en el Postfix 192.168.1.44 |
| Alta por API, roles y reautenticación (ESS-AUTH-004/005/006) | DONE | #7, #11 | Revisión de otra persona |
| Importación de EMPLEADOS (ESS-IMPORT-002) | DONE (código); BLOQUEADO (datos: EST = A) | #8 | Recibir exportación con EST V/C |
| Empresas y catálogos (ESS-ORG-001) | DONE | #9, #17 | Corregir CCOSTOS y CARGOS en el origen |
| Roles con alcance y jefes de área (ESS-ORG-002) | DONE | #10 | Suplencias |
| Stack local, Graphify y pruebas de navegador | DONE | #12, #13, #15 | — |
| Acceso web (ESS-WEB-001) | DONE | #14 | — |
| Volantes de pago PDF (ESS-PAY-001) | DONE (código); sin datos reales | #16 | Muestra anonimizada de NOMINA |
| Módulo administrativo, API e interfaz (ESS-ADM-001/002) | DONE | #17, #18 | Cargar los archivos reales por la interfaz |
| Rediseño de la interfaz (ESS-UX-001) | DONE | #19 | Conmutador de tema, lectores de pantalla reales |
| Certificados de retención (ESS-TAX-001) | DONE | #22 | Política de retención de los PDF |
| Vacaciones: `PROG_VAC`, festivos, solicitud y aprobaciones (ESS-LEAVE-001/002/003, ESS-HOL-001) | DONE (sin PDF con firmas) | #26, #28, #29, #33, #34 | PDF con firmas, suplencias, corrección de disfrutes, reintento de la API de festivos |
| Permisos (ESS-PERM-001) | DONE (decide solo el jefe de área) | #30 | Reglas por tipo si Gestión Humana las define |
| Correo saliente configurable | DONE | #35 | Habilitar STARTTLS en el servidor interno |
| Clave asignada por el administrador y doble paso opcional | DONE | #36 | Límite por IP |
| Almacenamiento de objetos con Garage (ADR-003) | DONE | (este PR) | Rotación de OBJECT_ENCRYPTION_KEY, política de retención |
| Certificados laborales, aviso de baja y ZIP | BACKLOG | — | Fases 3 y 4 de la SSD |

## Bloqueos
- `EMPLEADOS.xlsx` trae `EST = A` en las 240 filas; sin `V`/`C` no se pueden importar empleados reales ni crear cuentas.
- `CCOSTOS.xlsx` (1 código con dos descripciones) y `CARGOS.xlsx` (17 códigos) no se pueden publicar hasta corregirlos en el origen o definir clave oficial; 22 empleados usan centro de costo ambiguo y 80 cargo ambiguo.
- Falta definir la política de retención de las filas de preparación con datos personales y de la auditoría de peticiones.
- Restantes de la sección 12 de la SSD: baja y conservación de documentos, firmantes de certificados y operación de producción.
- El servidor de correo interno (192.168.1.44:25) no tiene TLS: los códigos viajan sin cifrar dentro de la red.

## Entorno de desarrollo
- Base de desarrollo `nomflow` y de pruebas `nomflow_test` (las pruebas vacían las tablas: usar siempre `DATABASE_URL=.../nomflow_test`).
- Stack local: `npm run stack:up` (ver [local-stack](local-stack.md)).
