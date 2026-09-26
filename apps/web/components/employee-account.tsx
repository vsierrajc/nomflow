'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, formatDate } from '@/components/admin-ui';
import { PasswordField } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface AccountView {
  exists: boolean;
  id: string | null;
  username: string;
  status: 'PENDIENTE_VERIFICACION' | 'ACTIVA' | 'BLOQUEADA' | null;
  mustChangePassword: boolean | null;
  twoFactorEnabled: boolean;
  twoFactorEnabledAt: string | null;
  employeeActive: boolean;
}

const STATUS: Record<string, string> = {
  PENDIENTE_VERIFICACION: 'Pendiente de activación',
  ACTIVA: 'Activa',
  BLOQUEADA: 'Bloqueada',
};

const ERRORS: Record<string, string> = {
  WEAK_PASSWORD:
    'La clave debe tener al menos 12 caracteres y ser distinta del correo del empleado.',
  SELF: 'No puede cambiar su propia clave desde aquí; use «Mi cuenta».',
  FORBIDDEN:
    'Solo un administrador del sistema puede cambiar la clave de una cuenta administradora.',
  CONFLICT: 'La cuenta está bloqueada: desbloquéela primero en «Cuentas y roles».',
  NO_ACTIVE_CONTRACT: 'El empleado no tiene un contrato vigente.',
  ACCOUNT_EXISTS: 'Ese empleado ya tiene una cuenta.',
  EMAIL_MISSING: 'El empleado no tiene correo registrado.',
  NOT_ENABLED: 'El doble paso ya estaba desactivado.',
};

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_';

/** Clave aleatoria de 16 caracteres generada en el navegador; no viaja hasta que se asigna. */
function generatePassword(): string {
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * Cuenta de acceso del empleado: el usuario es su correo. El administrador puede crearla o asignarle
 * una clave, y ver o desactivar (por recuperación) su verificación en dos pasos.
 */
export function EmployeeAccount({ nIde }: { nIde: string }) {
  const { call } = useAdmin();
  const [account, setAccount] = useState<AccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [mailFailed, setMailFailed] = useState(false);
  const [password, setPassword] = useState('');
  const [requireChange, setRequireChange] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await call<AccountView>(`/admin/accounts/by-employee/${encodeURIComponent(nIde)}`);
    if (res.status === 200 && res.data) setAccount(res.data);
    else setError(NETWORK_ERROR);
  }, [call, nIde]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    const code = (res.data as { code?: string } | undefined)?.code ?? '';
    if (res.status === 403 && !code) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[code] ?? NETWORK_ERROR);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    setShown(null);
    setBusy(true);
    const res = await call<{ temporaryPassword: string; verificationSent: boolean }>(
      '/admin/accounts',
      {
        method: 'POST',
        body: { nIde, ...(password ? { password } : {}) },
      },
    );
    setBusy(false);
    if (res.status === 201 && res.data) {
      setOk(
        res.data.verificationSent
          ? 'Cuenta creada. Se envió al correo del empleado el código para activarla.'
          : 'Cuenta creada, pero no se pudo enviar el código por correo: reenvíelo desde «Cuentas y roles».',
      );
      // Una clave elegida por el administrador no se muestra; una generada se muestra una sola vez.
      if (res.data.temporaryPassword) setShown(res.data.temporaryPassword);
      setPassword('');
      await load();
    } else fail(res);
  }

  async function assign(e: FormEvent) {
    e.preventDefault();
    if (!account?.id) return;
    setError(null);
    setOk(null);
    setShown(null);
    setBusy(true);
    const res = await call<{ status: string; verificationSent: boolean }>(
      `/admin/accounts/${account.id}/set-password`,
      { method: 'POST', body: { password, requireChange } },
    );
    setBusy(false);
    if (res.status === 200 && res.data) {
      setOk(
        res.data.status === 'ACTIVA'
          ? 'Clave asignada. El empleado ya puede ingresar con ella; sus sesiones abiertas se cerraron.'
          : res.data.verificationSent
            ? 'Clave asignada. El empleado debe activar su cuenta con esa clave y el código que se le envió al correo, y elegir una propia.'
            : 'Clave asignada, pero NO se pudo enviar el código por correo: el empleado puede pedirlo de nuevo en la pantalla de activación.',
      );
      setPassword('');
      await load();
    } else fail(res);
  }

  /** Restablece la clave: NOMFLOW genera una temporal y se muestra aquí, por si el correo no llega. */
  async function reset() {
    if (!account?.id) return;
    setError(null);
    setOk(null);
    setShown(null);
    setCopied(false);
    setConfirmReset(false);
    setMailFailed(false);
    setBusy(true);
    const res = await call<{ temporaryPassword: string; verificationSent: boolean }>(
      `/admin/accounts/${account.id}/reset-password`,
      { method: 'POST', body: {} },
    );
    setBusy(false);
    if (res.status === 200 && res.data) {
      setShown(res.data.temporaryPassword);
      setMailFailed(!res.data.verificationSent);
      setOk(
        res.data.verificationSent
          ? 'Clave restablecida. Se envió al correo del empleado el código para activar la cuenta.'
          : 'Clave restablecida, pero NO se pudo enviar el código por correo: entregue la clave temporal que se muestra abajo; el empleado puede pedir el código de nuevo en la pantalla de activación.',
      );
      await load();
    } else if (res.status === 422)
      setError('El empleado no tiene un contrato vigente: no se puede restablecer su clave.');
    else if (res.status === 409) setError('La acción no aplica al estado actual de la cuenta.');
    else fail(res);
  }

  /** Con el correo caído: deja la cuenta activa con la clave temporal que se acaba de mostrar. */
  async function activateNow() {
    if (!account?.id || !shown) return;
    setError(null);
    setBusy(true);
    const res = await call(`/admin/accounts/${account.id}/set-password`, {
      method: 'POST',
      body: { password: shown, requireChange: false, activateNow: true },
    });
    setBusy(false);
    if (res.status === 200) {
      setMailFailed(false);
      setOk(
        'La cuenta quedó activa: el empleado ya puede ingresar con la clave temporal (conviene que la cambie en «Mi cuenta»).',
      );
      await load();
    } else fail(res);
  }

  async function disableTwoFactor() {
    if (!account?.id) return;
    setError(null);
    setOk(null);
    setBusy(true);
    const res = await call(`/admin/accounts/${account.id}/two-factor/disable`, {
      method: 'POST',
      body: {},
    });
    setBusy(false);
    if (res.status === 200) {
      setOk(
        'Verificación en dos pasos desactivada. El empleado puede volver a activarla en «Mi cuenta».',
      );
      await load();
    } else fail(res);
  }

  return (
    <section aria-label="Cuenta de acceso">
      <h3>Cuenta de acceso</h3>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {shown ? (
        <Notice kind="ok">
          Clave temporal generada (se muestra una sola vez; entréguela por un canal seguro):{' '}
          <code data-testid="temporary-password">{shown}</code>{' '}
          <button
            type="button"
            className="secondary small"
            onClick={() => void navigator.clipboard?.writeText(shown).then(() => setCopied(true))}
          >
            {copied ? 'Copiada' : 'Copiar clave'}
          </button>
          {mailFailed ? (
            <>
              {' '}
              <button
                type="button"
                className="secondary small"
                disabled={busy}
                onClick={() => void activateNow()}
              >
                Activar la cuenta ahora con esta clave (sin código)
              </button>
            </>
          ) : null}
        </Notice>
      ) : null}
      {account === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <dl className="stats">
            <div>
              <dt>Usuario</dt>
              <dd>{account.username}</dd>
            </div>
            <div>
              <dt>Estado de la cuenta</dt>
              <dd>
                {account.status ? (
                  <Badge kind={account.status === 'ACTIVA' ? 'ok' : 'off'}>
                    {STATUS[account.status]}
                  </Badge>
                ) : (
                  'Sin cuenta'
                )}
              </dd>
            </div>
            {account.exists ? (
              <div>
                <dt>Verificación en dos pasos</dt>
                <dd>
                  {account.twoFactorEnabled
                    ? `Activada${account.twoFactorEnabledAt ? ` desde el ${formatDate(account.twoFactorEnabledAt)}` : ''}`
                    : 'No activada (es opcional; la activa el empleado en «Mi cuenta»)'}
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="muted">
            El usuario para ingresar es el correo del empleado. La clave que asigne no se muestra de
            nuevo ni se envía por correo.
          </p>

          {!account.employeeActive ? (
            <p className="muted">
              El empleado no tiene un contrato vigente: no se puede crear ni cambiar su cuenta.
            </p>
          ) : account.status === 'BLOQUEADA' ? (
            <p className="muted">
              La cuenta está bloqueada: desbloquéela en «Cuentas y roles» para poder asignar una
              clave.
            </p>
          ) : (
            <form onSubmit={account.exists ? assign : create} noValidate>
              <PasswordField
                label={account.exists ? 'Clave nueva' : 'Clave inicial (opcional)'}
                name="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                hint={
                  account.exists
                    ? 'Mínimo 12 caracteres y distinta del correo.'
                    : 'Si la deja vacía, el sistema genera una clave temporal. Mínimo 12 caracteres.'
                }
              />
              <div className="toolbar">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setPassword(generatePassword())}
                >
                  Generar clave
                </button>
              </div>
              {account.exists && account.status === 'ACTIVA' ? (
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={requireChange}
                    onChange={(e) => setRequireChange(e.target.checked)}
                  />
                  <span>
                    Exigir que el empleado la cambie al ingresar (recibirá un código por correo para
                    activarla de nuevo). Si la desmarca, podrá ingresar de inmediato con esta clave.
                  </span>
                </label>
              ) : null}
              <button type="submit" disabled={busy || (account.exists && password === '')}>
                {account.exists ? 'Asignar clave' : 'Crear cuenta'}
              </button>
            </form>
          )}

          {account.exists && account.employeeActive && account.status !== 'BLOQUEADA' ? (
            <div>
              <p className="muted">
                Si el empleado olvidó su clave, puede restablecerla: NOMFLOW genera una clave
                temporal, la muestra aquí (por si el correo falla), cierra sus sesiones y le envía
                un código para activar la cuenta de nuevo.
              </p>
              {confirmReset ? (
                <div className="toolbar">
                  <button type="button" disabled={busy} onClick={() => void reset()}>
                    Sí, restablecer y mostrar la clave
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setConfirmReset(false)}
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  Restablecer clave (generar una temporal)
                </button>
              )}
            </div>
          ) : null}

          {account.exists && account.twoFactorEnabled ? (
            <div>
              <p className="muted">
                Si el empleado perdió el acceso a su correo, puede desactivarle el doble paso para
                que ingrese solo con su clave. Queda registrado en la auditoría.
              </p>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void disableTwoFactor()}
              >
                Desactivar doble paso
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
