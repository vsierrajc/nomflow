/** Tema de la interfaz: «system» sigue al dispositivo; «light» y «dark» son una elección de la persona. */
export type Theme = 'system' | 'light' | 'dark';

export const THEME_KEY = 'nomflow-theme';

export const THEME_LABEL: Record<Theme, string> = {
  system: 'Automático (según su dispositivo)',
  light: 'Claro',
  dark: 'Oscuro',
};

export function isTheme(v: unknown): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** La elección guardada en este navegador (por omisión, automático). */
export function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Aplica el tema al documento y lo recuerda; sin almacenamiento disponible solo vale para esta pantalla. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // sin almacenamiento (ventana privada o bloqueado): el tema rige hasta recargar
  }
}
