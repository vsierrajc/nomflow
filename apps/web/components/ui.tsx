'use client';

import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = input.id ?? `${input.name}-${auto}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...input} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="card">
      <h1>{title}</h1>
      {children}
    </main>
  );
}
