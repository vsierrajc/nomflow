const bogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' });

/**
 * Fecha de hoy en Colombia (AAAA-MM-DD), la que usa el servidor para vigencias y suplencias. Con
 * `toISOString()` (UTC), desde las 19:00 el campo de fecha ofrecería «mañana» como hoy.
 */
export const todayBogota = (now: Date = new Date()): string => bogota.format(now);
