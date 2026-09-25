'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Settings {
  notifyApprover: boolean;
  notifyEmployee: boolean;
  reminderDays: number;
  appUrl: string;
}

interface Overview {
  settings: Settings;
  recent: { id: string; kind: string; requestType: string; sentAt: string; recipient: string }[];
}

const KIND: Record<string, string> = {
  NUEVA: 'Actividad nueva',
  RESULTADO: 'Respuesta al empleado',
  RECORDATORIO: 'Recordatorio',
};

export default function NotificationsPage() {
  const { call } = useAdmin();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await call<Overview>('/admin/notifications');
    if (res.status === 200 && res.data) setData(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call<Settings>('/admin/notifications/settings', {
      method: 'PUT',
      body: {
        notifyApprover: f.get('notifyApprover') === 'on',
        notifyEmployee: f.get('notifyEmployee') === 'on',
        reminderDays: Number(f.get('reminderDays')),
        appUrl: String(f.get('appUrl') ?? '').trim(),
      },
    });
    if (res.status === 200) {
      setOk('Configuración guardada. Se aplica en el próximo envío.');
      await load();
    } else if (res.status === 400)
      setError(
        'Revise los datos: los días del recordatorio van de 0 a 30 y la dirección debe empezar por https:// o http://.',
      );
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  const s = data?.settings;
  return (
    <>
      <PageHeader title="Notificaciones del flujo" />
      <p className="muted">
        NOMFLOW avisa por correo cuando una solicitud de vacaciones o de permiso llega a alguien
        para decidir, cuando el empleado debe responder a un cambio propuesto y cuando hay una
        respuesta final. Si una actividad sigue sin atender, se recuerda. Solo se escribe a cuentas
        ya activadas, y las actividades siempre están en la Bandeja de entrada de la aplicación.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {data === null || !s ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <section className="import-panel" aria-label="Configuración de avisos">
            <h2>Avisos</h2>
            <form onSubmit={save} noValidate key={JSON.stringify(s)}>
              <label className="choice">
                <input type="checkbox" name="notifyApprover" defaultChecked={s.notifyApprover} />
                <span>
                  Avisar al jefe de área y al aprobador final cuando les llega una solicitud
                </span>
              </label>
              <label className="choice">
                <input type="checkbox" name="notifyEmployee" defaultChecked={s.notifyEmployee} />
                <span>Avisar al empleado de la respuesta o de un cambio propuesto</span>
              </label>
              <div className="grid-2">
                <Field
                  label="Recordar tras (días sin atender)"
                  name="reminderDays"
                  type="number"
                  min={0}
                  max={30}
                  defaultValue={s.reminderDays}
                  required
                  hint="Se repite cada ese número de días mientras siga pendiente. 0 desactiva los recordatorios."
                />
                <Field
                  label="Dirección de NOMFLOW para el enlace"
                  name="appUrl"
                  defaultValue={s.appUrl}
                  optional
                  maxLength={200}
                  hint="Por ejemplo https://nomflow.gr4l.co. Si se deja vacía, el correo solo indica abrir la Bandeja de entrada."
                />
              </div>
              <button type="submit">Guardar configuración</button>
            </form>
          </section>

          <section className="import-panel" aria-label="Avisos enviados">
            <h2>Últimos avisos enviados</h2>
            {data.recent.length === 0 ? (
              <p className="muted">Todavía no se ha enviado ninguno.</p>
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Historial de avisos"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Fecha</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Destinatario</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((r) => (
                      <tr key={r.id}>
                        <td>{formatDate(r.sentAt)}</td>
                        <td>
                          {KIND[r.kind] ?? r.kind} (
                          {r.requestType === 'VACACION' ? 'vacaciones' : 'permiso'})
                        </td>
                        <td>{r.recipient}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
