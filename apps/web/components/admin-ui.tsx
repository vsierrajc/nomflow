'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <div className="toolbar">{children}</div>
    </div>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pager" aria-label="Paginación">
      <span className="muted">
        {total} {total === 1 ? 'registro' : 'registros'} - página {page} de {pages}
      </span>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Anterior
        </button>
        <button
          type="button"
          className="secondary"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Siguiente
        </button>
      </div>
    </nav>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, button, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop">
      <div
        ref={ref}
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="secondary" onClick={onClose} aria-label="Cerrar">
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SelectField({
  label,
  name,
  value,
  onChange,
  options,
  required,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  required?: boolean;
}) {
  const auto = useId();
  const id = `${name}-${auto}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Badge({ kind, children }: { kind: 'ok' | 'warn' | 'off'; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(iso));
}
