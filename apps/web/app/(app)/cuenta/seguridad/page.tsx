'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Notice, formatDate } from '@/components/admin-ui';
import { Alert, Field, Loading, PasswordField, SubmitButton } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface State {
  enabled: boolean;
  enabledAt: string | null;
}

function errorText(status: number, data: unknown): string {
  const code = ((data ?? {}) as { code?: string }).code;
  if (status === 0) return NETWORK_ERROR;
  if (status === 429)
    return 'Ya pidió varios códigos en la última hora. Espere un rato e intente de nuevo.';
  if (status === 502 || code === 'MAIL_FAILED')
    return 'No se pudo enviar el código porque el correo no está disponible ahora. Avise a Gestión Humana.';
  if (status === 401) return 'La clave es incorrecta.';
  if (status === 403) return 'Se canceló la confirmación de identidad.';
  if (code === 'ALREADY_ENABLED') return 'La verificación en dos pasos ya está activada.';
  if (code === 'NOT_ENABLED') return 'La verificación en dos pasos no está activada.';
  if (code === 'INVALID_CODE') return 'El código es incorrecto, venció o ya se usó.';
  return NETWORK_ERROR;
}

export default function TwoFactorPage() {
  const { call, profile } = useAdmin();
  const [state, setState] = useState<State | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await call<State>('/me/two-factor');
    if (res.status === 200 && res.data) setState(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function start() {
    setError(null);
    setOk(null);
    setBusy(true);
    const res = await call<{ challengeId: string }>('/me/two-factor/start', {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setChallenge(res.data.challengeId);
      setOk(`Le enviamos un código de 6 dígitos a ${profile.email}.`);
    } else setError(errorText(res.status, res.data));
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setOk(null);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return setError('Escriba los 6 dígitos del código.');
    setBusy(true);
    const res = await call<State>('/me/two-factor/confirm', {
      method: 'POST',
      body: { challengeId: challenge, code },
    });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setState(res.data);
      setChallenge(null);
      setOk(
        'Verificación en dos pasos activada. Desde ahora, al ingresar se le pedirá un código enviado a su correo.',
      );
    } else setError(errorText(res.status, res.data));
  }

  async function disable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    if (!password) return setError('Escriba su clave para confirmar.');
    setBusy(true);
    const res = await call<State>('/me/two-factor/disable', { method: 'POST', body: { password } });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setState(res.data);
      form.reset();
      setOk('Verificación en dos pasos desactivada.');
    } else setError(errorText(res.status, res.data));
  }

  return (
    <>
      <div className="page-head">
        <h1>Verificación en dos pasos</h1>
        <p className="muted">
          Es opcional. Si la activa, además de su clave, cada ingreso pide un código de 6 dígitos
          que le llega a su correo ({profile.email}). Así, aunque alguien conozca su clave, no podrá
          entrar sin acceso a su correo.
        </p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {state === null && !error ? <Loading>Consultando su seguridad…</Loading> : null}

      {state !== null && !state.enabled ? (
        <section className="panel" aria-label="Activar la verificación en dos pasos">
          <h2>Estado: no activada</h2>
          {challenge === null ? (
            <>
              <p>
                Para activarla le enviaremos un código al correo, para comprobar que usted lo
                recibe.
              </p>
              <button type="button" onClick={() => void start()} disabled={busy}>
                {busy ? 'Enviando…' : 'Enviarme un código'}
              </button>
            </>
          ) : (
            <form onSubmit={confirm} noValidate>
              <Field
                label="Código recibido por correo"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                required
                hint="Vence en 10 minutos y solo sirve una vez."
              />
              <div className="actions">
                <SubmitButton busy={busy} busyText="Activando…">
                  Activar verificación en dos pasos
                </SubmitButton>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void start()}
                  disabled={busy}
                >
                  Enviar otro código
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      {state !== null && state.enabled ? (
        <section className="panel" aria-label="Desactivar la verificación en dos pasos">
          <h2>Estado: activada</h2>
          <p>
            Está activada desde el {state.enabledAt ? formatDate(state.enabledAt) : 'día indicado'}.
            Cada ingreso pide un código enviado a su correo.
          </p>
          <form onSubmit={disable} noValidate>
            <PasswordField
              label="Clave (para desactivarla)"
              name="password"
              autoComplete="current-password"
              required
            />
            <button type="submit" className="secondary" disabled={busy}>
              Desactivar verificación en dos pasos
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
