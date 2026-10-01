export interface Substitution {
  id: string;
  titularAccountId: string;
  titular: string;
  substituteAccountId: string;
  substitute: string;
  validFrom: string;
  validTo: string;
  status: 'ACTIVA' | 'TERMINADA' | 'ANULADA';
  /** VIGENTE, PROGRAMADA o VENCIDA (si está activa) o su estado final. */
  phase: 'VIGENTE' | 'PROGRAMADA' | 'VENCIDA' | 'TERMINADA' | 'ANULADA';
  endedAt: string | null;
  endReason: string | null;
}

export interface MySubstitutions {
  eligible: boolean;
  maxDays: number;
  asTitular: Substitution[];
  asSubstitute: Substitution[];
}

export const PHASE_LABEL: Record<Substitution['phase'], string> = {
  VIGENTE: 'Vigente',
  PROGRAMADA: 'Programada',
  VENCIDA: 'Vencida',
  TERMINADA: 'Terminada',
  ANULADA: 'Anulada',
};

export const phaseKind = (p: Substitution['phase']): 'ok' | 'warn' | 'off' =>
  p === 'VIGENTE' ? 'ok' : p === 'PROGRAMADA' ? 'warn' : 'off';

const ERRORS: Record<string, string> = {
  NOT_APPROVER: 'Solo quienes aprueban solicitudes pueden designar un suplente.',
  SELF: 'No puede designarse a sí mismo.',
  INVALID_DATES: 'Revise las fechas: la final no puede ser anterior a la inicial.',
  PAST_START: 'La suplencia no puede empezar en una fecha pasada.',
  TOO_LONG: 'Una suplencia dura como máximo 90 días.',
  SUBSTITUTE_NOT_ELIGIBLE:
    'Esa persona no puede ser suplente: debe tener cuenta activa y un rol que apruebe solicitudes.',
  NO_COMMON_COMPANY: 'Esa persona aprueba en otra empresa: el suplente debe ser de la misma.',
  OVERLAP: 'Ya tiene una suplencia en esas fechas.',
  CHAIN:
    'No se pueden encadenar suplencias: el suplente no puede estar a su vez suplido en esas fechas.',
  NOT_FOUND: 'No se encontró la suplencia.',
  NOT_ACTIVE: 'La suplencia ya no está activa.',
  REASON_REQUIRED: 'Escriba un motivo de al menos 10 caracteres.',
};

export function substitutionError(status: number, data: unknown, fallback: string): string {
  const code = ((data ?? {}) as { code?: string }).code;
  if (status === 403 && !code) return 'Se canceló la confirmación de identidad.';
  return ERRORS[code ?? ''] ?? fallback;
}

export const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
