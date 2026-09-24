'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, PasswordField, Requirements, SubmitButton } from '@/components/ui';
import { MIN_PASSWORD_LENGTH, NETWORK_ERROR, api } from '@/lib/api';
import { useReadyProfile } from '@/lib/use-profile';

interface Errors {
  current?: string;
  next?: string;
  confirm?: string;
}

export default function ChangePasswordPage() {
  const profile = useReadyProfile();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const refs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  const rules = [
    { met: next.length >= MIN_PASSWORD_LENGTH, text: `Al menos ${MIN_PASSWORD_LENGTH} caracteres` },
    {
      met: current.length > 0 && next.length > 0 && next !== current,
      text: 'Distinta de la clave actual',
    },
    {
      met: confirm.length > 0 && next === confirm,
      text: 'La confirmación coincide con la clave nueva',
    },
  ];

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const found: Errors = {};
    if (!current) found.current = 'Escriba su clave actual.';
    if (next.length < MIN_PASSWORD_LENGTH)
      found.next = `La clave nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    else if (next === current) found.next = 'La clave nueva debe ser distinta de la actual.';
    if (!found.next && next !== confirm)
      found.confirm = 'La confirmación no coincide con la clave nueva.';
    setErrors(found);
    setFormError(null);
    setOk(false);
    const first = (['current', 'next', 'confirm'] as const).find((k) => found[k]);
    if (first) {
      refs[first].current?.focus();
      return;
    }

    setBusy(true);
    const res = await api('/auth/change-password', {
      method: 'POST',
      csrf: profile.csrfToken,
      body: { currentPassword: current, newPassword: next },
    });
    setBusy(false);
    if (res.status === 204) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setOk(true);
    } else if (res.status === 0) setFormError(NETWORK_ERROR);
    else if (res.status === 401) {
      setErrors({ current: 'La clave actual es incorrecta.' });
      refs.current.current?.focus();
    } else setFormError('No se pudo cambiar la clave. Revise los datos e intente de nuevo.');
  }

  return (
    <>
      <div className="page-head">
        <h1>Mi cuenta</h1>
        <p className="muted">{profile.email}</p>
      </div>
      <section className="panel narrow" aria-labelledby="cambiar-clave">
        <h2 id="cambiar-clave" style={{ marginTop: 0 }}>
          Cambiar mi clave
        </h2>
        {ok ? (
          <Alert kind="ok">
            Clave cambiada. Por seguridad, sus otras sesiones abiertas se cerraron; esta sigue
            activa.
          </Alert>
        ) : null}
        {formError ? <Alert kind="error">{formError}</Alert> : null}
        <form onSubmit={onSubmit} noValidate>
          <PasswordField
            label="Clave actual"
            name="currentPassword"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            error={errors.current}
            inputRef={refs.current}
          />
          <PasswordField
            label="Clave nueva"
            name="newPassword"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
            error={errors.next}
            inputRef={refs.next}
          />
          <PasswordField
            label="Confirmar clave nueva"
            name="confirm"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={errors.confirm}
            inputRef={refs.confirm}
          />
          <Requirements items={rules} />
          <div className="actions">
            <SubmitButton busy={busy} busyText="Guardando…">
              Cambiar clave
            </SubmitButton>
            <Link className="button secondary" href="/">
              Volver al inicio
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}
