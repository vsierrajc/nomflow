'use client';

import { useState, type FormEvent } from 'react';
import { Notice } from '@/components/admin-ui';
import { Alert, Field, SubmitButton } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

export interface TotpState {
  enabled: boolean;
  enabledAt: string | null;
  method: 'EMAIL' | 'TOTP';
  recoveryCodesLeft: number;
}

export function totpErrorText(status: number, data: unknown): string {
  const code = ((data ?? {}) as { code?: string }).code;
  if (status === 0) return NETWORK_ERROR;
  if (status === 429) return 'Demasiados intentos. Espere unos minutos e intente de nuevo.';
  if (status === 401) return 'La clave es incorrecta.';
  if (status === 403) return 'Se canceló la confirmación de identidad.';
  if (code === 'ALREADY_ENABLED') return 'La app autenticadora ya está activada.';
  if (code === 'NOT_PENDING') return 'Empiece de nuevo la configuración para obtener un QR.';
  if (code === 'INVALID_CODE')
    return 'El código es incorrecto o ya se usó. Los códigos de la app cambian cada 30 segundos.';
  return NETWORK_ERROR;
}

/** Códigos de respaldo: se muestran una sola vez y hay que confirmar que se guardaron. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([`Códigos de respaldo de NOMFLOW\n\n${text}\n`], { type: 'text/plain' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nomflow-codigos-de-respaldo.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel" aria-label="Códigos de respaldo">
      <h2>Guarde sus códigos de respaldo</h2>
      <p>
        Si pierde el teléfono, cada uno de estos {codes.length} códigos le permite ingresar una sola
        vez. <strong>No se volverán a mostrar.</strong> Guárdelos en un lugar seguro, fuera de este
        equipo.
      </p>
      <ul aria-label="Lista de códigos de respaldo" className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="secondary" onClick={() => void copy()}>
          Copiar códigos
        </button>
        <button type="button" className="secondary" onClick={download}>
          Descargar como archivo
        </button>
      </div>
      {copied ? <Notice kind="ok">Códigos copiados al portapapeles.</Notice> : null}
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Ya
        guardé mis códigos de respaldo
      </label>
      <button type="button" disabled={!saved} onClick={onDone}>
        Terminar
      </button>
    </section>
  );
}

/** Asistente de activación: QR y clave manual, luego el primer código de la app. */
export function TotpEnroll({
  onActivated,
  onCancel,
}: {
  onActivated: (state: TotpState, recoveryCodes: string[]) => void;
  onCancel: () => void;
}) {
  const { call } = useAdmin();
  const [qr, setQr] = useState<{ qrDataUrl: string; manualKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setError(null);
    setBusy(true);
    const res = await call<{ qrDataUrl: string; manualKey: string }>('/me/two-factor/totp/start', {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (res.status === 200 && res.data) setQr(res.data);
    else setError(totpErrorText(res.status, res.data));
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return setError('Escriba los 6 dígitos que muestra la app.');
    setBusy(true);
    const res = await call<TotpState & { recoveryCodes: string[] }>('/me/two-factor/totp/confirm', {
      method: 'POST',
      body: { code },
    });
    setBusy(false);
    if (res.status === 200 && res.data) {
      const { recoveryCodes, ...state } = res.data;
      onActivated(state, recoveryCodes);
    } else setError(totpErrorText(res.status, res.data));
  }

  if (!qr)
    return (
      <section className="panel" aria-label="Configurar app autenticadora">
        <h2>Configurar app autenticadora</h2>
        <p>
          Necesita Microsoft Authenticator o Google Authenticator en su teléfono. Le mostraremos un
          código QR para escanear.
        </p>
        {error ? <Alert kind="error">{error}</Alert> : null}
        <div className="actions">
          <button type="button" onClick={() => void start()} disabled={busy}>
            {busy ? 'Preparando…' : 'Mostrar código QR'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </section>
    );

  return (
    <section className="panel" aria-label="Configurar app autenticadora">
      <h2>Escanee el código QR</h2>
      <ol>
        <li>Abra la app autenticadora y elija añadir una cuenta.</li>
        <li>Escanee este código QR.</li>
        <li>Escriba abajo los 6 dígitos que muestra la app para NOMFLOW.</li>
      </ol>
      <img
        src={qr.qrDataUrl}
        width={256}
        height={256}
        alt="Código QR para añadir NOMFLOW a su app autenticadora. Si no puede escanearlo, use la clave de configuración manual que aparece debajo."
      />
      <details>
        <summary>¿No puede escanear? Use la clave manual</summary>
        <p>
          En la app elija «Ingresar clave de configuración» y escriba esta clave (tipo basado en
          tiempo):
        </p>
        <p>
          <code aria-label="Clave de configuración manual">{qr.manualKey}</code>
        </p>
      </details>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <form onSubmit={confirm} noValidate>
        <Field
          label="Código de la app"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
          hint="Son 6 dígitos y cambian cada 30 segundos."
        />
        <div className="actions">
          <SubmitButton busy={busy} busyText="Activando…">
            Activar app autenticadora
          </SubmitButton>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </section>
  );
}
