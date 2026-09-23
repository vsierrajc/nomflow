# Estado del proyecto NOMFLOW

- Versión: 0.0.0 (pre-lanzamiento; sin despliegue en producción)
- Última bitácora: [2026-09-23-jefes-de-area](sessions/2026-09-23-jefes-de-area.md)
- `main` contiene los PR #1 a #9 integrados; el PR de jefes de área (ESS-ORG-002) está en revisión.
- Revisión por otra persona: ninguno de los PR integrados fue revisado por alguien distinto del autor y `main` no tiene protección de rama (la SSD, sección 11, la exige).

| módulo | estado | incidencia/PR | siguiente acción |
| --- | --- | --- | --- |
| Monorepo, CI y ADR-001/002 (ESS-OPS-001) | DONE | PR #1, #2 | Activar Code scanning (CodeQL falla sin él) |
| Cuentas, login y sesiones (ESS-AUTH-001/003) | DONE | PR #3, #4, #5 | Segundo factor por correo, límite por IP |
| Verificación SMTP y activación (ESS-AUTH-002) | DONE | PR #6 | Habilitar STARTTLS en el Postfix 192.168.1.44 |
| Alta administrativa por API, roles y reautenticación (ESS-AUTH-004/005) | DONE | PR #7 | Revisión de otra persona |
| Importación de EMPLEADOS (ESS-IMPORT-002) | DONE (código); BLOQUEADO (datos: EST = A) | PR #8 | Recibir exportación con EST V/C |
| Empresas y catálogos (ESS-ORG-001) | PARCIAL | PR #9 | CRUD de entradas individuales; corregir CCOSTOS y CARGOS en el origen |
| Roles con alcance y jefes de área (ESS-ORG-002) | IN_REVIEW | PR ESS-ORG-002 | Integrar; asignar jefes reales cuando existan sus cuentas |
| Volantes, certificados, ZIP, vacaciones, festivos, permisos | BACKLOG | — | Fases 3 y 4 |

## Bloqueos
- `EMPLEADOS.xlsx` trae `EST = A` en las 240 filas; sin `V`/`C` no se pueden importar empleados reales ni crear cuentas.
- `CCOSTOS.xlsx` (1 código con dos descripciones) y `CARGOS.xlsx` (17 códigos) no se pueden publicar hasta corregirlos en el origen o definir clave oficial; 22 empleados usan centro de costo ambiguo y 80 cargo ambiguo.
- Falta definir la política de retención de las filas de *staging* con datos personales.
- Restantes de la sección 12 de la SSD: `PROG_VAC`, festivos, baja y conservación, operación de producción.

## Entorno de desarrollo
- Base de desarrollo `nomflow` y base de pruebas `nomflow_test` (las pruebas vacían las tablas: usar siempre `DATABASE_URL=.../nomflow_test`).
- Empresa `GA` (GRALCO) registrada y catálogos `AREA` y `TIPO_CONTRATO` cargados en la base local de desarrollo.
