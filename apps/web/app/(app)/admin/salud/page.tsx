'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

type Level = 'OK' | 'WARN' | 'CRIT' | 'UNKNOWN';

interface Settings {
  storageWarnFreePct: number;
  storageCritFreePct: number;
  dbWarnMs: number;
  dbCritMs: number;
  objectErrorsWarn: number;
  objectErrorsCrit: number;
  errorWindowMin: number;
  checkIntervalMin: number;
  renotifyMin: number;
  extraRecipients: string;
}

interface Status {
  checkedAt: string;
  overall: Level;
  checks: { key: string; label: string; level: Level; message: string }[];
  settings: Settings;
}

interface Alert {
  id: string;
  checkKey: string;
  level: string;
  message: string;
  openedAt: string;
  resolvedAt: string | null;
}

const LABEL: Record<Level, string> = {
  OK: 'En orden',
  WARN: 'Aviso',
  CRIT: 'Crítico',
  UNKNOWN: 'Sin datos',
};
const KIND: Record<Level, 'ok' | 'warn' | 'off'> = {
  OK: 'ok',
  WARN: 'warn',
  CRIT: 'off',
  UNKNOWN: 'warn',
};

const INVALID =
  'Revise los umbrales: el nivel crítico debe ser menor que el de aviso en el espacio libre y mayor en latencia y errores; el intervalo va de 1 a 60 minutos, el reenvío de 15 a 1440 y los correos deben ser válidos.';

export default function HealthPage() {
  const { call } = useAdmin();
  const [status, setStatus] = useState<Status | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      call<Status>('/admin/health'),
      call<{ alerts: Alert[] }>('/admin/health/alerts?limit=30'),
    ]);
    if (s.status === 200 && s.data) setStatus(s.data);
    else setError(NETWORK_ERROR);
    if (a.status === 200 && a.data) setAlerts(a.data.alerts);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function checkNow() {
    setError(null);
    setOk(null);
    setBusy(true);
    const res = await call('/admin/health/check', { method: 'POST' });
    setBusy(false);
    if (res.status === 200) setOk('Verificación terminada.');
    else setError(NETWORK_ERROR);
    await load();
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const n = (k: string) => Number(f.get(k));
    const res = await call<Settings>('/admin/health/settings', {
      method: 'PUT',
      body: {
        storageWarnFreePct: n('storageWarnFreePct'),
        storageCritFreePct: n('storageCritFreePct'),
        dbWarnMs: n('dbWarnMs'),
        dbCritMs: n('dbCritMs'),
        objectErrorsWarn: n('objectErrorsWarn'),
        objectErrorsCrit: n('objectErrorsCrit'),
        errorWindowMin: n('errorWindowMin'),
        checkIntervalMin: n('checkIntervalMin'),
        renotifyMin: n('renotifyMin'),
        extraRecipients: String(f.get('extraRecipients') ?? ''),
      },
    });
    if (res.status === 200) {
      setOk('Umbrales guardados. Se aplican desde la próxima verificación.');
      await load();
    } else if (res.status === 400) setError(INVALID);
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  const s = status?.settings;
  return (
    <>
      <PageHeader title="Salud del sistema">
        <button type="button" onClick={() => void checkNow()} disabled={busy}>
          {busy ? 'Verificando…' : 'Revisar ahora'}
        </button>
      </PageHeader>
      <p className="muted">
        NOMFLOW vigila el almacenamiento de objetos, la base de datos, los errores de descarga y el
        correo. Cuando algo pasa a aviso o a crítico, envía un correo a los administradores; avisa
        de nuevo si sigue crítico y cuando se resuelve.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      {status === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <section className="import-panel" aria-label="Estado actual">
            <h2>
              Estado actual: <Badge kind={KIND[status.overall]}>{LABEL[status.overall]}</Badge>
            </h2>
            <p className="muted">Última verificación: {formatDate(status.checkedAt)}</p>
            <div
              className="table-wrap"
              tabIndex={0}
              role="region"
              aria-label="Comprobaciones de salud"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Elemento</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {status.checks.map((c) => (
                    <tr key={c.key} data-testid={`check-${c.key}`}>
                      <th scope="row">{c.label}</th>
                      <td>
                        <Badge kind={KIND[c.level]}>{LABEL[c.level]}</Badge>
                      </td>
                      <td>{c.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {s ? (
            <section className="import-panel" aria-label="Umbrales">
              <h2>Umbrales y destinatarios</h2>
              <form onSubmit={save} noValidate key={JSON.stringify(s)}>
                <div className="grid-2">
                  <Field
                    label="Espacio libre: aviso (%)"
                    name="storageWarnFreePct"
                    type="number"
                    min={2}
                    max={95}
                    defaultValue={s.storageWarnFreePct}
                    required
                  />
                  <Field
                    label="Espacio libre: crítico (%)"
                    name="storageCritFreePct"
                    type="number"
                    min={1}
                    max={90}
                    defaultValue={s.storageCritFreePct}
                    required
                    hint="Debe ser menor que el de aviso."
                  />
                  <Field
                    label="Base de datos: aviso (ms)"
                    name="dbWarnMs"
                    type="number"
                    min={10}
                    defaultValue={s.dbWarnMs}
                    required
                  />
                  <Field
                    label="Base de datos: crítico (ms)"
                    name="dbCritMs"
                    type="number"
                    min={20}
                    defaultValue={s.dbCritMs}
                    required
                  />
                  <Field
                    label="Errores de descarga: aviso"
                    name="objectErrorsWarn"
                    type="number"
                    min={1}
                    defaultValue={s.objectErrorsWarn}
                    required
                  />
                  <Field
                    label="Errores de descarga: crítico"
                    name="objectErrorsCrit"
                    type="number"
                    min={1}
                    defaultValue={s.objectErrorsCrit}
                    required
                  />
                  <Field
                    label="Ventana de errores (minutos)"
                    name="errorWindowMin"
                    type="number"
                    min={5}
                    max={1440}
                    defaultValue={s.errorWindowMin}
                    required
                  />
                  <Field
                    label="Verificar cada (minutos)"
                    name="checkIntervalMin"
                    type="number"
                    min={1}
                    max={60}
                    defaultValue={s.checkIntervalMin}
                    required
                  />
                  <Field
                    label="Repetir alerta crítica cada (minutos)"
                    name="renotifyMin"
                    type="number"
                    min={15}
                    max={1440}
                    defaultValue={s.renotifyMin}
                    required
                  />
                </div>
                <Field
                  label="Correos adicionales"
                  name="extraRecipients"
                  defaultValue={s.extraRecipients}
                  optional
                  maxLength={2000}
                  hint="Separados por coma. Además reciben las alertas todos los administradores activos."
                />
                <button type="submit">Guardar umbrales</button>
              </form>
            </section>
          ) : null}

          <section className="import-panel" aria-label="Historial de alertas">
            <h2>Historial de alertas</h2>
            {alerts.length === 0 ? (
              <p className="muted">Sin alertas registradas.</p>
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Alertas registradas"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Abierta</th>
                      <th scope="col">Nivel</th>
                      <th scope="col">Detalle</th>
                      <th scope="col">Resuelta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((a) => (
                      <tr key={a.id}>
                        <td>{formatDate(a.openedAt)}</td>
                        <td>
                          <Badge kind={a.level === 'CRIT' ? 'off' : 'warn'}>
                            {a.level === 'CRIT' ? 'Crítico' : 'Aviso'}
                          </Badge>
                        </td>
                        <td>{a.message}</td>
                        <td>{a.resolvedAt ? formatDate(a.resolvedAt) : 'Abierta'}</td>
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
