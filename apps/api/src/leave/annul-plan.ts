import { addDays } from './business-days';

/**
 * Hasta cuándo cuentan como ya disfrutados los días de un disfrute en curso al anularlo:
 * YESTERDAY (por omisión): hasta ayer, hoy todavía no cuenta; TODAY: hoy ya cuenta como disfrutado.
 */
export type EnjoyedUntil = 'YESTERDAY' | 'TODAY';

export interface ReturnPlan<A> {
  /** Último día que cuenta como disfrutado. */
  cutoff: string;
  /** Días hábiles ya disfrutados (se conservan descontados). */
  enjoyedDays: number;
  /** Días hábiles que vuelven a los períodos. */
  returnedDays: number;
  allocations: (A & { returned: number })[];
}

/**
 * Qué se devuelve al anular un disfrute: solo los días hábiles que aún no se han disfrutado. Los ya
 * disfrutados (los días contados hasta `cutoff`) se cargan primero a los períodos más antiguos, porque son
 * los primeros que se consumen; lo demás vuelve a los períodos restantes. Un disfrute que no ha empezado
 * lo devuelve todo.
 */
export function planReturn<A extends { progVacId: string; perIni: string; days: number }>(
  countedDays: readonly string[],
  allocations: readonly A[],
  today: string,
  until: EnjoyedUntil,
): ReturnPlan<A> {
  const cutoff = until === 'TODAY' ? today : addDays(today, -1);
  const total = allocations.reduce((sum, a) => sum + a.days, 0);
  const enjoyedDays = Math.min(total, countedDays.filter((d) => d <= cutoff).length);
  let remaining = enjoyedDays;
  const byAge = [...allocations].sort(
    (a, b) => a.perIni.localeCompare(b.perIni) || a.progVacId.localeCompare(b.progVacId),
  );
  const out = byAge.map((a) => {
    const kept = Math.min(a.days, remaining);
    remaining -= kept;
    return { ...a, returned: a.days - kept };
  });
  return {
    cutoff,
    enjoyedDays,
    returnedDays: out.reduce((sum, a) => sum + a.returned, 0),
    allocations: out,
  };
}
