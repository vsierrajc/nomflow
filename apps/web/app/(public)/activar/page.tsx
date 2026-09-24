'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { AuthCard } from '@/components/shells';
import { Alert, Field, PasswordField, Requirements, SubmitButton } from '@/components/ui';
import { MIN_PASSWORD_LENGTH, NETWORK_ERROR, api } from '@/lib/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Errors {
  email?: string;
  temporaryPassword?: string;
  code?: string;
  newPassword?: string;
  confirm?: string;
}

export default function ActivatePage() {
  const [email, setEmail] = useState('');
  const [temporary, setTemporary] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const refs = {
    email: useRef<HTMLInputElement>(null),
    temporaryPassword: useRef<HTMLInputElement>(null),
    code: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  const rules = [
    {
      met: newPassword.length >= MIN_PASSWORD_LENGTH,
      text: `Al menos ${MIN_PASSWORD_LENGTH} caracteres`,
    },
    {
      met: newPassword.length > 0 && newPassword !== temporary,
      text: 'Distinta de la clave temporal',
    },
    {
      met: confirm.length > 0 && newPassword === confirm,
      text: 'La confirmación coincide con la clave nueva',
    },
  ];

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    const next: Errors = {};
    if (!email.trim()) next.email = 'Escriba el correo donde recibió el código.';
    else if (!EMAIL_RE.test(email.trim())) next.email = 'Escriba un correo válido.';
    if (!temporary)
      next.temporaryPassword = 'Escriba la clave temporal que le entregó Gestión Humana.';
    if (!code) next.code = 'Escriba el código de 8 caracteres que llegó a su correo.';
    if (newPassword.length < MIN_PASSWORD_LENGTH)
      next.newPassword = `La clave nueva debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    else if (newPassword === temporary)
      next.newPassword = 'La clave nueva debe ser distinta de la temporal.';
    if (!next.newPassword && newPassword !== confirm)
      next.confirm = 'La confirmación no coincide con la clave nueva.';
    setErrors(next);
    setFormError(null);
    const first = (['email', 'temporaryPassword', 'code', 'newPassword', 'confirm'] as const).find(
      (k) => next[k],
    );
    if (first) {
      refs[first].current?.focus();
      return;
    }

    setBusy(true);
    const res = await api('/auth/activate', {
      method: 'POST',
      body: { email: email.trim(), temporaryPassword: temporary, code, newPassword },
    });
    setBusy(false);
    if (res.status === 204) setDone(true);
    else if (res.status === 0) setFormError(NETWORK_ERROR);
    else
      setFormError(
        'No se pudo activar la cuenta. Revise el correo, la clave temporal y el código (vence a los 15 minutos), o solicite un código nuevo.',
      );
  }

  async function resend() {
    if (sending) return;
    setResendNotice(null);
    setResendError(null);
    if (!EMAIL_RE.test(email.trim())) {
      setResendError('Escriba su correo para recibir un código nuevo.');
      refs.email.current?.focus();
      return;
    }
    setSending(true);
    const res = await api('/auth/verify-email/resend', {
      method: 'POST',
      body: { email: email.trim() },
    });
    setSending(false);
    if (res.status === 202)
      setResendNotice(
        'Si la cuenta está pendiente de activación, se envió un código nuevo a su correo. Puede tardar unos minutos.',
      );
    else if (res.status === 0) setResendError(NETWORK_ERROR);
    else setResendError('Escriba un correo válido.');
  }

  if (done) {
    return (
      <AuthCard title="Cuenta activada">
        <Alert kind="ok">Su cuenta quedó activa. Ya puede ingresar con su clave nueva.</Alert>
        <div className="actions">
          <Link className="button" href="/login">
            Ir a ingresar
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      wide
      title="Activar mi cuenta"
      lead="Es el primer paso para usar NOMFLOW: confirme que el correo es suyo y cree su propia clave."
      help={
        <p>
          ¿Ya tiene una cuenta activa? <Link href="/login">Volver a ingresar</Link>.
        </p>
      }
    >
      {formError ? <Alert kind="error">{formError}</Alert> : null}
      <form onSubmit={onSubmit} noValidate>
        <fieldset>
          <legend>Verifique su identidad</legend>
          <Field
            label="Correo electrónico"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            inputRef={refs.email}
            hint="El correo registrado por Gestión Humana."
          />
          <PasswordField
            label="Clave temporal"
            name="temporaryPassword"
            autoComplete="off"
            required
            value={temporary}
            onChange={(e) => setTemporary(e.target.value)}
            error={errors.temporaryPassword}
            inputRef={refs.temporaryPassword}
            hint="Se la entregó Gestión Humana por un canal distinto al correo."
          />
          <Field
            label="Código del correo"
            name="code"
            type="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={16}
            required
            error={errors.code}
            inputRef={refs.code}
            hint="Son 8 letras y números; vence a los 15 minutos y sirve una sola vez."
          />
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() => void resend()}
              disabled={sending}
              aria-busy={sending}
            >
              {sending ? 'Enviando…' : 'Reenviar código'}
            </button>
          </div>
          <div aria-live="polite">
            {resendNotice ? <Alert kind="info">{resendNotice}</Alert> : null}
            {resendError ? <Alert kind="error">{resendError}</Alert> : null}
          </div>
        </fieldset>

        <fieldset>
          <legend>Cree su clave nueva</legend>
          <PasswordField
            label="Clave nueva"
            name="newPassword"
            autoComplete="new-password"
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={errors.newPassword}
            inputRef={refs.newPassword}
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
        </fieldset>

        <div className="actions">
          <SubmitButton busy={busy} busyText="Activando…">
            Activar cuenta
          </SubmitButton>
        </div>
      </form>
    </AuthCard>
  );
}
