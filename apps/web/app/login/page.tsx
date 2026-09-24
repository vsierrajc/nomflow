'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Card, Field } from '../../components/ui';
import { NETWORK_ERROR, api } from '../../lib/api';
import { useProfile } from '../../lib/use-profile';

export default function LoginPage() {
  const router = useRouter();
  const { state } = useProfile();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.status === 'ready') router.replace('/');
  }, [state, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await api('/auth/login', {
      method: 'POST',
      body: {
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      },
    });
    setBusy(false);
    if (res.status === 200) router.replace('/');
    else if (res.status === 0) setError(NETWORK_ERROR);
    else if (res.status === 400) setError('Escriba un correo válido y su clave.');
    else setError('Correo o clave incorrectos, o la cuenta no está disponible.');
  }

  return (
    <Card title="Ingresar">
      {error ? <Alert kind="error">{error}</Alert> : null}
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Correo electrónico"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
        <Field
          label="Clave"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Ingresando…' : 'Ingresar'}
          </button>
        </div>
      </form>
      <div className="links">
        <Link href="/activar">Activar mi cuenta con el código del correo</Link>
      </div>
    </Card>
  );
}
