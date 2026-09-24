# Sesión: 2026-09-24 - vacaciones, base (PROG_VAC y festivos)
- Responsable / agente: Claude Code
- Objetivo e incidencias: ESS-LEAVE-001, ESS-HOL-001 y el cálculo de ESS-LEAVE-002
- Rama: feat/ESS-LEAVE-solicitudes desde main
- Cambios realizados: tablas `prog_vac`, `prog_vac_adjustments`, `holiday_calendars`, `holidays` (migración 0016, con CHECK `0 <= disp <= dias <= 15`); `business-days.ts` (días hábiles, festivos, retorno, cruce de año); CRUD de `PROG_VAC` y carga Excel (parser, vista previa, aplicación atómica con ajuste versionado); festivos con borrador y publicación; `/me/vacations/periods` y `/preview`; pantallas `/admin/vacaciones` y `/admin/festivos`
- Decisiones: una carga que toca un período existente corrige DIAS/DISP con ajuste trazable (lote y fecha de corte en el motivo); el calendario se versiona por año y solo el publicado se usa; sin calendario publicado del año no se calcula (HTTP 422 con los años faltantes)
- Pruebas y evidencia: 233 pruebas de API antes de la carga Excel y 17 en `leave` después; 3 pruebas de navegador nuevas. La prueba de navegador encontró un fallo real: `e.currentTarget` es null tras un `await` y el alta no refrescaba la lista
- Bloqueos y riesgos: la muestra `PROG_VAC.xlsx` no está en el repositorio, el parser se probó con su estructura documentada (números en N_IDE/N_CONT, fechas DD/MM/AAAA)
- Estado final: parcial (base lista)
- Próximo paso: solicitud de vacaciones (`VacationRequest`, asignaciones, revisiones), aprobación del jefe y final, `VACACIONES`, PDF con firmas; permisos; festivos por API y por Excel
