'use client';

import { useEffect, useState } from 'react';
import { THEME_LABEL, applyTheme, readTheme, type Theme } from '@/lib/theme';

const OPTIONS: Theme[] = ['system', 'light', 'dark'];

const ANNOUNCE: Record<Theme, string> = {
  system: 'Tema automático: sigue la configuración de su dispositivo.',
  light: 'Tema claro activado.',
  dark: 'Tema oscuro activado.',
};

/** La persona elige cómo ver la aplicación; la elección queda en este navegador. */
export default function AppearancePage() {
  const [theme, setTheme] = useState<Theme>('system');
  const [announce, setAnnounce] = useState<string | null>(null);

  useEffect(() => {
    setTheme(readTheme());
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
    setAnnounce(ANNOUNCE[next]);
  }

  return (
    <>
      <div className="page-head">
        <h1>Apariencia</h1>
        <p className="muted">
          Elija si prefiere la interfaz clara u oscura. La elección se guarda en este navegador; en
          otro dispositivo se elige de nuevo.
        </p>
      </div>
      <section className="panel" aria-labelledby="tema">
        <h2 id="tema">Tema</h2>
        <fieldset>
          <legend>Tema de la interfaz</legend>
          {OPTIONS.map((t) => (
            <label key={t} className="choice">
              <input
                type="radio"
                name="tema"
                value={t}
                checked={theme === t}
                onChange={() => choose(t)}
              />
              <span>{THEME_LABEL[t]}</span>
            </label>
          ))}
        </fieldset>
        <div role="status" aria-live="polite">
          {announce ? (
            <p className="alert alert-ok">
              <span className="sr-only">Listo: </span>
              <span>{announce}</span>
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}
