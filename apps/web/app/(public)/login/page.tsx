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
  const [expired, setExpired] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  // Segundo paso (opcional): el código enviado al correo, para quien activó la verificación en dos pasos.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setExpired(new URLSearchParams(window.location.search).get('expirada') === '1');
  }, []);

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
    const res = await api<{ twoFactorRequired?: boolean; challengeId?: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setBusy(false);
    if (res.status === 200) {
      if (res.data?.twoFactorRequired && res.data.challengeId) {
        setChallenge(res.data.challengeId);
        return;
      }
      router.replace('/');
      return;
    }
    if (res.status === 0) setFormError(NETWORK_ERROR);
    else if (res.status === 400) setFormError('Revise el correo y la clave e intente de nuevo.');
    else
      setFormError(
        'Correo o clave incorrectos, o la cuenta no está disponible. Si le entregaron una clave temporal, primero debe activarla con el enlace «Activar mi cuenta». Si necesita ayuda, solicítela a Gestión Humana.',
      );
    passwordRef.current?.focus();
    passwordRef.current?.select();
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !challenge) return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    setCodeError(null);
    if (!/^\d{6}$/.test(code)) {
      setCodeError('Escriba los 6 dígitos del código.');
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    const res = await api('/auth/login/verify', {
      method: 'POST',
      body: { challengeId: challenge, code },
    });
    setBusy(false);
    if (res.status === 200) {
      router.replace('/');
      return;
    }
    setCodeError(
      res.status === 0
        ? NETWORK_ERROR
        : 'El código es incorrecto, venció o ya se usó. Tras varios intentos fallidos debe volver a ingresar su clave para recibir uno nuevo.',
    );
    codeRef.current?.focus();
    codeRef.current?.select();
  }

  if (challenge)
    return (
      <LoginLanding
        title="Verificación en dos pasos"
        lead="Le enviamos un código de 6 dígitos al correo de su cuenta. Escríbalo para terminar de ingresar."
        help={
          <p>
            El código vence en 10 minutos y solo sirve una vez. Si no le llega, revise la carpeta de
            correo no deseado o vuelva a ingresar para pedir uno nuevo.
          </p>
        }
      >
        {codeError ? <Alert kind="error">{codeError}</Alert> : null}
        <form onSubmit={onVerify} noValidate>
          <Field
            label="Código de verificación"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            required
            inputRef={codeRef}
          />
          <div className="actions">
            <SubmitButton busy={busy} busyText="Verificando…">
              Verificar
            </SubmitButton>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setChallenge(null);
                setCodeError(null);
              }}
            >
              Volver a ingresar
            </button>
          </div>
        </form>
      </LoginLanding>
    );

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
      {expired && !formError ? (
        <Alert kind="info">
          Su sesión expiró por inactividad o se cerró desde otro lugar. Ingrese de nuevo para
          continuar.
        </Alert>
      ) : null}
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
