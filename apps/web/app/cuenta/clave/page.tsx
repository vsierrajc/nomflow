'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Card, Field } from '../../../components/ui';
import { MIN_PASSWORD_LENGTH, NETWORK_ERROR, api } from '../../../lib/api';
import { useProfile } from '../../../lib/use-profile';

export default function ChangePasswordPage() {
  const router = useRouter();
  const { state } = useProfile();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
  }, [state, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.status !== 'ready') return;
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const currentPassword = String(form.get('currentPassword') ?? '');
    const newPassword = String(form.get('newPassword') ?? '');
    setError(null);
    setOk(false);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`La clave nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (newPassword === currentPassword) {
      setError('La clave nueva debe ser distinta de la actual.');
      return;
    }
    if (newPassword !== String(form.get('confirm') ?? '')) {
      setError('La confirmación no coincide con la clave nueva.');
      return;
    }
    setBusy(true);
    const res = await api('/auth/change-password', {
      method: 'POST',
      csrf: state.profile.csrfToken,
      body: { currentPassword, newPassword },
    });
    setBusy(false);
    if (res.status === 204) {
      formEl.reset();
      setOk(true);
    } else if (res.status === 0) setError(NETWORK_ERROR);
    else if (res.status === 401) setError('La clave actual es incorrecta.');
    else setError('No se pudo cambiar la clave. Revise los datos e intente de nuevo.');
  }

  if (state.status === 'loading' || state.status === 'anonymous') {
    return <Card title="Cambiar mi clave">Cargando…</Card>;
  }
  if (state.status === 'error') {
    return (
      <Card title="Cambiar mi clave">
        <Alert kind="error">{NETWORK_ERROR}</Alert>
      </Card>
    );
  }

  return (
    <Card title="Cambiar mi clave">
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? (
        <Alert kind="ok">Clave cambiada. Sus otras sesiones abiertas se cerraron.</Alert>
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Clave actual"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <Field
          label="Clave nueva"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          hint={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres y distinta de la actual.`}
          required
        />
        <Field
          label="Confirmar clave nueva"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Cambiar clave'}
          </button>
          <Link className="button secondary" href="/">
            Volver
          </Link>
        </div>
      </form>
    </Card>
  );
}
