# Estado del proyecto NOMFLOW

- Versión: 0.0.0 (pre-desarrollo)
- Última bitácora: [2026-09-23-import-empleados](sessions/2026-09-23-import-empleados.md)
- Rama: feat/ESS-IMPORT-002-empleados (apilada sobre PR #7; main contiene PR #1 a #6)

| módulo | estado | incidencia/PR | siguiente acción |
| --- | --- | --- | --- |
| Documentación base | DONE (esqueleto) | — | Crear incidencias de fase 1 |
| Monorepo y CI (ESS-OPS-001) | IN_REVIEW | rama feat/ESS-OPS-001-monorepo | Abrir PR; crear ADR-002 (ORM) |
| Importación EMPLEADOS (ESS-IMPORT-002) y cuentas/login/SMTP/alta (ESS-AUTH-*) | IN_REVIEW | rama feat/ESS-IMPORT-002-empleados | Catálogos (áreas, cargos, centros de costo, tipos de contrato) y validación cruzada; segundo factor en login; rate limit por IP |

## Bloqueos
Ver sección 12 de la SSD (datos de origen: EST=A, CARGOS y CCOSTOS duplicados, PROG_VAC, festivos).
