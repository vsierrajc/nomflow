# Estado del proyecto NOMFLOW

- Versión: 0.0.0 (pre-lanzamiento; sin despliegue en producción)
- **Traspaso para la próxima sesión: [HANDOFF.md](HANDOFF.md)** (pendientes, próximos pasos y trampas conocidas).
- Última bitácora: [2026-09-24-handoff-graphify](sessions/2026-09-24-handoff-graphify.md)
- `main` contiene los PR #1 a #19 integrados; no hay PR abiertos.
- Revisión por otra persona: ninguno de los PR fue revisado por alguien distinto del autor y `main` no tiene protección de rama (la SSD, sección 11, la exige).
- Pruebas: 215 de API y 81 de navegador en verde. Ver [README](../README.md) para la visión general.

| módulo | estado | PR | siguiente acción |
| --- | --- | --- | --- |
| Monorepo, CI y ADR-001/002 (ESS-OPS-001) | DONE | #1, #2 | CodeQL sube a Code scanning (repositorio público) y el job falla si hay hallazgos |
| Cuentas, login y sesiones (ESS-AUTH-001/003) | DONE | #3, #4, #5 | Segundo factor por correo, límite por IP |
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
| Certificados laborales y tributarios, ZIP y baja, vacaciones, permisos, festivos | BACKLOG | — | Fases 3 y 4 de la SSD |

## Bloqueos
- `EMPLEADOS.xlsx` trae `EST = A` en las 240 filas; sin `V`/`C` no se pueden importar empleados reales ni crear cuentas.
- `CCOSTOS.xlsx` (1 código con dos descripciones) y `CARGOS.xlsx` (17 códigos) no se pueden publicar hasta corregirlos en el origen o definir clave oficial; 22 empleados usan centro de costo ambiguo y 80 cargo ambiguo.
- Falta definir la política de retención de las filas de preparación con datos personales y de la auditoría de peticiones.
- Restantes de la sección 12 de la SSD: `PROG_VAC`, festivos, baja y conservación, operación de producción.

## Entorno de desarrollo
- Base de desarrollo `nomflow` y de pruebas `nomflow_test` (las pruebas vacían las tablas: usar siempre `DATABASE_URL=.../nomflow_test`).
- Stack local: `npm run stack:up` (ver [local-stack](local-stack.md)).
