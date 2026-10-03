/**
 * Fechas de negocio en Colombia (America/Bogota, UTC-5, sin horario de verano). Vigencias de roles y
 * asignaciones, suplencias, calendarios y nombres de archivo se cuentan por el día de Colombia: con UTC,
 * desde las 19:00 locales «hoy» ya sería mañana (un rol que vence hoy se daría por vencido cinco horas
 * antes, y uno que empieza mañana, por vigente).
 */
const bogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' });

/** La fecha (AAAA-MM-DD) que tiene `date` en Colombia. */
export const dateBogota = (date: Date): string => bogota.format(date);

/** Fecha de hoy en Colombia (AAAA-MM-DD). */
export const todayBogota = (now: Date = new Date()): string => dateBogota(now);
