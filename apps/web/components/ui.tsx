'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  optional?: boolean | undefined;
  inputRef?: Ref<HTMLInputElement> | undefined;
}

function useFieldIds(name: string | undefined, id: string | undefined) {
  const auto = useId();
  const base = id ?? `${name ?? 'campo'}-${auto}`;
  return { id: base, hintId: `${base}-hint`, errorId: `${base}-error` };
}

export function Field({ label, hint, error, optional, inputRef, ...input }: FieldProps) {
  const { id, hintId, errorId } = useFieldIds(input.name, input.id);
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional ? <span className="label-optional"> (opcional)</span> : null}
      </label>
      <input
        {...input}
        id={id}
        ref={inputRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          <span className="sr-only">Error: </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function PasswordField({
  label,
  hint,
  error,
  inputRef,
  ...input
}: Omit<FieldProps, 'type' | 'optional'>) {
  const { id, hintId, errorId } = useFieldIds(input.name, input.id);
  const [visible, setVisible] = useState(false);
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-row">
        <input
          {...input}
          id={id}
          ref={inputRef}
          type={visible ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoCapitalize="none"
          spellCheck={false}
        />
        <button
          type="button"
          className="secondary"
          aria-pressed={visible}
          aria-controls={id}
          aria-label={visible ? 'Ocultar clave' : 'Mostrar clave'}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          <span className="sr-only">Error: </span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const ALERT_PREFIX = {
  error: 'Error',
  ok: 'Listo',
  info: 'Información',
  warn: 'Atención',
} as const;

export function Alert({
  kind,
  children,
  alertRef,
}: {
  kind: keyof typeof ALERT_PREFIX;
  children: ReactNode;
  alertRef?: Ref<HTMLParagraphElement> | undefined;
}) {
  return (
    <p
      ref={alertRef}
      tabIndex={kind === 'error' ? -1 : undefined}
      className={`alert alert-${kind}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <span className="sr-only">{ALERT_PREFIX[kind]}: </span>
      <span>{children}</span>
    </p>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ children = 'Cargando…' }: { children?: ReactNode }) {
  return (
    <p className="loading" role="status">
      <Spinner />
      <span>{children}</span>
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function SubmitButton({
  busy,
  children,
  busyText,
}: {
  busy: boolean;
  children: ReactNode;
  busyText?: string;
}) {
  return (
    <button type="submit" disabled={busy} aria-busy={busy}>
      {busy ? <Spinner /> : null}
      {busy && busyText ? busyText : children}
    </button>
  );
}

export function Requirements({ items }: { items: { met: boolean; text: string }[] }) {
  return (
    <ul className="requirements" aria-label="Requisitos de la clave">
      {items.map((i) => (
        <li key={i.text} className={i.met ? 'met' : ''}>
          <span>
            <span className="sr-only">{i.met ? 'Cumplido: ' : 'Pendiente: '}</span>
            {i.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
