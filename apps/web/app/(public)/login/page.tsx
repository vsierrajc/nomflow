'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoginLanding } from '@/components/shells';
import { Alert, Field, PasswordField, SubmitButton } from '@/components/ui';
import { NETWORK_ERROR, api } from '@/lib/api';
import { useProfile } from '@/lib/use-profile';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const router = useRouter();
  const { state } = useProfile();
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.status === 'ready') router.replace('/');
  }, [state, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const next: { email?: string; password?: string } = {};
    if (!email) next.email = 'Escriba su correo electrónico.';
    else if (!EMAIL_RE.test(email))
      next.email = 'Escriba un correo válido, por ejemplo nombre@empresa.com.';
    if (!password) next.password = 'Escriba su clave.';
    setErrors(next);
    setFormError(null);
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();

    setBusy(true);
    const res = await api('/auth/login', { method: 'POST', body: { email, password } });
    setBusy(false);
    if (res.status === 200) {
      router.replace('/');
      return;
    }
    if (res.status === 0) setFormError(NETWORK_ERROR);
    else if (res.status === 400) setFormError('Revise el correo y la clave e intente de nuevo.');
    else
      setFormError(
        'Correo o clave incorrectos, o la cuenta no está disponible. Si necesita ayuda, solicítela a Gestión Humana.',
      );
    passwordRef.current?.focus();
    passwordRef.current?.select();
  }

  return (
    <LoginLanding
      title="Ingresar"
      lead="Use el correo y la clave de su cuenta de NOMFLOW."
      help={
        <p>
          ¿Olvidó su clave? Solicite a Gestión Humana que la restablezca; recibirá una clave
          temporal y un código para activar de nuevo su cuenta.
        </p>
      }
    >
      {formError ? <Alert kind="error">{formError}</Alert> : null}
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Correo electrónico"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          error={errors.email}
          inputRef={emailRef}
        />
        <PasswordField
          label="Clave"
          name="password"
          autoComplete="current-password"
          required
          error={errors.password}
          inputRef={passwordRef}
        />
        <div className="actions">
          <SubmitButton busy={busy} busyText="Ingresando…">
            Ingresar
          </SubmitButton>
        </div>
      </form>
      <div className="links">
        <Link href="/activar">Activar mi cuenta con el código del correo</Link>
      </div>
    </LoginLanding>
  );
}
