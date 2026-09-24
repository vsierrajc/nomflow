'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field, PasswordField } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface MailSettings {
  source: 'ADMINISTRACION' | 'ENTORNO';
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  username: string | null;
  hasPassword: boolean;
  fromEmail: string;
  fromName: string | null;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  updatedAt: string | null;
}

const TEST_STATUS: Record<string, string> = {
  OK: 'Correcta',
  CONNECTION_FAILED: 'No se pudo conectar con el servidor',
  TLS_REQUIRED: 'El servidor no admite TLS',
  AUTH_FAILED: 'Usuario o clave rechazados',
  REJECTED: 'El servidor rechazó el mensaje o el destinatario',
  SEND_FAILED: 'El envío falló',
};

const ERRORS: Record<string, string> = {
  INVALID_SETTINGS:
    'Revise los datos: servidor (nombre o dirección IP), puerto entre 1 y 65535 y un correo de origen válido, por ejemplo nomflow@gr4l.co.',
  INVALID_RECIPIENT: 'Escriba un correo de destino válido.',
  NOT_CONFIGURED: 'Primero guarde la configuración del servidor de correo.',
  CONNECTION_FAILED:
    'No se pudo conectar con el servidor de correo. Revise el servidor y el puerto, y que sea alcanzable desde el servidor de NOMFLOW.',
  TLS_REQUIRED:
    'El servidor no admite TLS o STARTTLS. Si es un servidor interno sin TLS, desmarque «Exigir STARTTLS» (el correo viajará sin cifrar dentro de la red).',
  AUTH_FAILED: 'El servidor rechazó el usuario o la clave.',
  REJECTED: 'El servidor rechazó el mensaje o el destinatario.',
  SEND_FAILED: 'El envío falló por un motivo no identificado. Revise la configuración.',
};

export default function MailSettingsPage() {
  const { call, profile } = useAdmin();
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    const res = await call<MailSettings>('/admin/mail-settings');
    if (res.status === 200 && res.data) setSettings(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    const code = (res.data as { code?: string } | undefined)?.code ?? '';
    if (res.status === 403 && !code) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[code] ?? NETWORK_ERROR);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const password = String(f.get('password') ?? '');
    const res = await call<MailSettings>('/admin/mail-settings', {
      method: 'PUT',
      body: {
        host: String(f.get('host') ?? ''),
        port: Number(f.get('port')),
        secure: f.get('secure') === 'on',
        requireTls: f.get('requireTls') === 'on',
        username: String(f.get('username') ?? ''),
        ...(password ? { password } : {}),
        ...(f.get('clearPassword') ? { clearPassword: true } : {}),
        fromEmail: String(f.get('fromEmail') ?? ''),
        fromName: String(f.get('fromName') ?? ''),
      },
    });
    if (res.status === 200 && res.data) {
      setSettings(res.data);
      setOk('Configuración guardada. Los correos del sistema ya usan estos datos.');
      form.reset();
    } else fail(res);
  }

  async function test(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const to = String(new FormData(e.currentTarget).get('to') ?? '');
    setTesting(true);
    const res = await call<{ settings: MailSettings }>('/admin/mail-settings/test', {
      method: 'POST',
      body: { to },
    });
    setTesting(false);
    if (res.status === 200)
      setOk(`Correo de prueba enviado a ${to}. Revise que llegue a esa bandeja.`);
    else fail(res);
    await load();
  }

  return (
    <>
      <PageHeader title="Correo saliente (SMTP)" />
      <p className="muted">
        Con este servidor NOMFLOW envía los correos del sistema, como los códigos de verificación de
        cuenta. El cambio se aplica de inmediato. Si nadie guarda una configuración aquí, se usa la
        de las variables de entorno del servidor.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      {settings === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <section className="import-panel" aria-label="Estado del correo">
            <h2>Estado</h2>
            <p>
              {settings.configured
                ? `Servidor ${settings.host}:${settings.port}. Origen: ${settings.source === 'ADMINISTRACION' ? 'guardada en esta pantalla' : 'variables de entorno del servidor'}.`
                : 'Sin configurar: no se pueden enviar correos.'}
              {settings.lastTestStatus
                ? ` Última prueba: ${TEST_STATUS[settings.lastTestStatus] ?? settings.lastTestStatus}${settings.lastTestAt ? ` (${formatDate(settings.lastTestAt)})` : ''}.`
                : ''}
            </p>
          </section>

          <section className="import-panel" aria-label="Configuración del servidor">
            <h2>Servidor de correo</h2>
            <form onSubmit={save} noValidate key={settings.updatedAt ?? settings.source}>
              <div className="grid-2">
                <Field
                  label="Servidor SMTP (nombre o dirección IP)"
                  name="host"
                  defaultValue={settings.host}
                  required
                  maxLength={253}
                  hint="Por ejemplo 192.168.1.44 (servidor interno: puerto 25, sin TLS, sin usuario ni clave)."
                />
                <Field
                  label="Puerto"
                  name="port"
                  type="number"
                  min={1}
                  max={65535}
                  defaultValue={settings.port}
                  required
                  hint="25, 587 (STARTTLS) o 465 (SMTPS)."
                />
              </div>
              <label className="choice">
                <input type="checkbox" name="secure" defaultChecked={settings.secure} />
                <span>Conexión segura desde el inicio (SMTPS, normalmente puerto 465)</span>
              </label>
              <label className="choice">
                <input type="checkbox" name="requireTls" defaultChecked={settings.requireTls} />
                <span>
                  Exigir STARTTLS (no enviar si el servidor no lo ofrece). Desmárquelo solo para un
                  servidor interno sin TLS.
                </span>
              </label>
              <div className="grid-2">
                <Field
                  label="Usuario"
                  name="username"
                  defaultValue={settings.username ?? ''}
                  optional
                  maxLength={200}
                  autoComplete="off"
                  hint="Déjelo vacío si el servidor no pide autenticación."
                />
                <PasswordField
                  label="Clave del usuario"
                  name="password"
                  autoComplete="new-password"
                  hint={
                    settings.hasPassword
                      ? 'Ya hay una clave guardada. Escriba una nueva solo para reemplazarla.'
                      : 'Opcional. Se guarda cifrada y no se vuelve a mostrar.'
                  }
                />
              </div>
              {settings.hasPassword ? (
                <label className="choice">
                  <input type="checkbox" name="clearPassword" />
                  <span>Borrar la clave guardada</span>
                </label>
              ) : null}
              <div className="grid-2">
                <Field
                  label="Correo de origen (dirección From)"
                  name="fromEmail"
                  type="email"
                  defaultValue={settings.fromEmail}
                  required
                  maxLength={254}
                  autoComplete="off"
                  hint="Es la dirección que aparece como remitente en los correos, por ejemplo nomflow@gr4l.co."
                />
                <Field
                  label="Nombre del remitente"
                  name="fromName"
                  defaultValue={settings.fromName ?? ''}
                  optional
                  maxLength={80}
                  hint="Se muestra junto a la dirección, por ejemplo NOMFLOW."
                />
              </div>
              <button type="submit">Guardar configuración</button>
            </form>
          </section>

          <section className="import-panel" aria-label="Correo de prueba">
            <h2>Correo de prueba</h2>
            <p className="muted">
              Envía un mensaje con la configuración guardada para comprobar que funciona.
            </p>
            <form onSubmit={test} className="toolbar" noValidate>
              <Field
                label="Enviar la prueba a"
                name="to"
                type="email"
                defaultValue={profile.email}
                required
                maxLength={254}
              />
              <button
                type="submit"
                className="secondary"
                disabled={testing || !settings.configured}
              >
                {testing ? 'Enviando…' : 'Enviar correo de prueba'}
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
