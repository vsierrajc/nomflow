'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Card, Field } from '../../components/ui';
import { MIN_PASSWORD_LENGTH, NETWORK_ERROR, api } from '../../lib/api';

export default function ActivatePage() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get('newPassword') ?? '');
    setError(null);
    setNotice(null);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`La clave nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (newPassword !== String(form.get('confirm') ?? '')) {
      setError('La confirmación no coincide con la clave nueva.');
      return;
    }
    setBusy(true);
    const res = await api('/auth/activate', {
      method: 'POST',
      body: {
        email: String(form.get('email') ?? ''),
        temporaryPassword: String(form.get('temporaryPassword') ?? ''),
        code: String(form.get('code') ?? ''),
        newPassword,
      },
    });
    setBusy(false);
    if (res.status === 204) setDone(true);
    else if (res.status === 0) setError(NETWORK_ERROR);
    else
      setError(
        'No se pudo activar. Revise el correo, la clave temporal y el código, o solicite un código nuevo.',
      );
  }

  async function resend() {
    setError(null);
    setNotice(null);
    if (!email.includes('@')) {
      setError('Escriba su correo para recibir un código nuevo.');
      return;
    }
    const res = await api('/auth/verify-email/resend', { method: 'POST', body: { email } });
    if (res.status === 202)
      setNotice('Si la cuenta está pendiente de activación, se envió un código nuevo a su correo.');
    else if (res.status === 0) setError(NETWORK_ERROR);
    else setError('Escriba un correo válido.');
  }

  if (done) {
    return (
      <Card title="Cuenta activada">
        <Alert kind="ok">Su cuenta quedó activa. Ya puede ingresar con su clave nueva.</Alert>
        <Link className="button" href="/login">
          Ir a ingresar
        </Link>
      </Card>
    );
  }

  return (
    <Card title="Activar mi cuenta">
      <p className="muted">
        Use la clave temporal que le entregó Gestión Humana y el código de 8 caracteres enviado a su
        correo.
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="ok">{notice}</Alert> : null}
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Correo electrónico"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Clave temporal"
          name="temporaryPassword"
          type="password"
          autoComplete="off"
          required
        />
        <Field
          label="Código del correo"
          name="code"
          type="text"
          autoComplete="one-time-code"
          maxLength={16}
          required
        />
        <Field
          label="Clave nueva"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          hint={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres y distinta de la temporal.`}
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
            {busy ? 'Activando…' : 'Activar cuenta'}
          </button>
          <button type="button" className="secondary" onClick={() => void resend()}>
            Reenviar código
          </button>
        </div>
      </form>
      <div className="links">
        <Link href="/login">Volver a ingresar</Link>
      </div>
    </Card>
  );
}
