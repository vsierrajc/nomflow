const LABELS: Record<string, string> = {
  PES: 'pesos',
  HRS: 'horas',
  DIA: 'días',
  DIAS: 'días',
  UND: 'unidades',
};

export const UNIT_RE = /^[A-Z0-9]{1,10}$/;

export function unitLabel(unit: string | null | undefined): string | null {
  if (!unit) return null;
  return LABELS[unit] ?? unit.toLowerCase();
}

export function knownUnits(): { code: string; label: string }[] {
  return Object.entries(LABELS).map(([code, label]) => ({ code, label }));
}
