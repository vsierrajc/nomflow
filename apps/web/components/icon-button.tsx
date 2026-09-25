'use client';

import type { ReactNode } from 'react';

/** Iconos de trazo (24×24). Son solo dibujo: el nombre accesible lo da el botón. */
const ICONS: Record<'view' | 'edit' | 'delete' | 'restore', ReactNode> = {
  // Ojo
  view: (
    <>
      <path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // Lápiz
  edit: (
    <>
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  // Papelera
  delete: (
    <>
      <path d="M3.5 6h17" />
      <path d="M9 6V4h6v2" />
      <path d="M6 6l1 14h10l1-14" />
      <path d="M10 10v6M14 10v6" />
    </>
  ),
  // Flecha circular (reactivar)
  restore: (
    <>
      <path d="M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 005.6 6.4" />
      <path d="M3.5 3.5v3.4h3.4" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;

/**
 * Botón que solo muestra un icono. `label` es su nombre accesible y también su ayuda emergente,
 * porque sin texto visible un lector de pantalla no tendría otra forma de anunciarlo.
 */
export function IconButton({
  icon,
  label,
  onClick,
  variant = 'secondary',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  variant?: 'secondary' | 'danger';
}) {
  return (
    <button
      type="button"
      className={`icon-btn small ${variant}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[icon]}
      </svg>
    </button>
  );
}
