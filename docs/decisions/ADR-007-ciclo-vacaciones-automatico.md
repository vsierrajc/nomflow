# ADR-007: generación automática del ciclo de vacaciones

- Estado: aceptado (26 de septiembre de 2026)
- Contexto: cada 360 días desde el inicio del contrato (`EMPLEADOS.F_INI`), un empleado causa 15 días de vacaciones para el ciclo que termina ese día. Hasta ahora `PROG_VAC` solo se cargaba a mano o por Excel; no existía un disparador que generara el período automáticamente al cumplirse el ciclo.

## Decisión

- No se implementa como un trigger de PostgreSQL, porque un trigger reacciona a escrituras, no al simple paso del tiempo. Se implementa como una tarea diaria dentro de la API (mismo patrón que salud del sistema y avisos de vacaciones: `apps/api/src/leave/vacation-cycle-monitor.ts`), que llama a `runVacationCycles` (`apps/api/src/leave/vacation-cycle.service.ts`).
- El ciclo N (1-indexado) de un contrato cubre `[F_INI + (N-1)·360, F_INI + N·360 - 1]` en días calendario y otorga 15 días (`dias = disp = 15`, `estado = ACTIVA`, `source = AUTOMATICO`).
- Un contrato con varios ciclos atrasados al activar la regla solo recibe, como máximo, los 3 ciclos más recientes que le falten; los anteriores no se crean (se consideran prescritos).
- Tope de acumulación: un contrato no puede tener más de 3 períodos `ACTIVA` con días disponibles a la vez. Si generar un ciclo nuevo superaría el tope, el período `ACTIVA` más antiguo (por `PER_INI`) pasa a `VENCIDA` (`disp = 0`) antes de crear el nuevo. Un período `LIQUIDADA` (ya disfrutado) no cuenta para el tope.
- `VENCIDA` es un estado nuevo, distinto de `LIQUIDADA`: ambos tienen `disp = 0` y por tanto no se pueden solicitar (la regla de `leave-plan.ts` ya bloquea cualquier `disp <= 0`), pero se muestran distinto en la interfaz («Vencida» en vez de «Liquidada»).
- Cada creación o vencimiento queda auditado (`VACATION_CYCLE_CREATE` / `VACATION_CYCLE_EXPIRE`, `actorAccountId = null` porque no hay un actor humano) y es idempotente: correr la tarea dos veces el mismo día no duplica nada.
- La tarea se apaga con `VACATION_CYCLE_MONITOR=off` (las pruebas la desactivan igual que las demás tareas periódicas) y su intervalo es configurable por variable de entorno para pruebas.

## Pendiente

- Confirmar con Gestión Humana si «prescriben» es la palabra correcta para los ciclos atrasados que no se crean, y si alguna vez deben recuperarse manualmente.
- Decidir si `VENCIDA` debe notificarse al empleado o a Gestión Humana (hoy no envía ningún aviso).
