'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field, PasswordField } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Calendar {
  id: string;
  year: number;
  version: number;
  status: 'BORRADOR' | 'PUBLICADO' | 'REEMPLAZADO';
  source: string;
  reason: string | null;
  days: number;
  publishedAt: string | null;
}

interface ApiSettings {
  configured: boolean;
  url: string | null;
  hasApiKey: boolean;
  lastSyncAt: string | null;
  lastSyncYear: number | null;
  lastSyncStatus: string | null;
  updatedAt: string | null;
}

interface SyncResult {
  year: number;
  version: number;
  days: number;
  hadPublished: boolean;
  added: string[];
  removed: string[];
}

const SYNC_STATUS: Record<string, string> = {
  OK: 'Correcta',
  API_KEY_INVALID: 'La clave fue rechazada por el servicio',
  RATE_LIMITED: 'El servicio alcanzó su límite de consultas',
  UNAVAILABLE: 'El servicio no respondió',
  INVALID_RESPONSE: 'El servicio devolvió datos incompletos o inválidos',
};

const SYNC_ERROR: Record<string, string> = {
  API_KEY_INVALID: 'El servicio rechazó la clave (401). Revise la clave guardada.',
  RATE_LIMITED: 'El servicio alcanzó su límite de consultas (429). Intente más tarde.',
  UNAVAILABLE: 'El servicio no respondió. Se sigue usando el último calendario publicado.',
  INVALID_RESPONSE:
    'El servicio devolvió datos incompletos o inválidos. Se sigue usando el último calendario publicado.',
  NOT_CONFIGURED: 'Primero guarde la URL del servicio.',
  NO_API_KEY: 'Primero guarde la clave (API KEY) del servicio.',
  INVALID_YEAR: 'Escriba un año válido.',
  INVALID_URL:
    'La URL no es válida: use https, sin usuario, clave ni parámetros, y una dirección pública.',
};

const STATUS = {
  BORRADOR: 'Borrador',
  PUBLICADO: 'Publicado',
  REEMPLAZADO: 'Reemplazado',
} as const;

function parseLines(text: string): { date: string; name: string }[] | null {
  const out: { date: string; name: string }[] = [];
  for (const line of text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const m = /^(\d{4}-\d{2}-\d{2})\s*[;,]\s*(.+)$/.exec(line);
    if (!m?.[1] || !m[2]) return null;
    out.push({ date: m[1], name: m[2] });
  }
  return out;
}

export default function HolidaysPage() {
  const { call } = useAdmin();
  const [items, setItems] = useState<Calendar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [api, setApi] = useState<ApiSettings | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiOk, setApiOk] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const res = await call<Calendar[]>('/admin/holidays');
    if (res.status === 200 && res.data) setItems(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  const loadApi = useCallback(async () => {
    const res = await call<ApiSettings>('/admin/holiday-api');
    if (res.status === 200 && res.data) setApi(res.data);
    else setApiError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
    void loadApi();
  }, [load, loadApi]);

  function apiFail(res: { status: number; data?: unknown }) {
    const code = (res.data as { code?: string } | undefined)?.code ?? '';
    if (res.status === 403 && !code) setApiError('Se canceló la confirmación de identidad.');
    else setApiError(SYNC_ERROR[code] ?? NETWORK_ERROR);
  }

  async function saveApi(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setApiError(null);
    setApiOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const apiKey = String(f.get('apiKey') ?? '');
    const res = await call<ApiSettings>('/admin/holiday-api', {
      method: 'PUT',
      body: {
        url: String(f.get('url') ?? ''),
        ...(apiKey ? { apiKey } : {}),
        ...(f.get('clearApiKey') ? { clearApiKey: true } : {}),
      },
    });
    if (res.status === 200 && res.data) {
      setApi(res.data);
      setApiOk(
        'Configuración guardada. La clave queda cifrada en el servidor y no se vuelve a mostrar.',
      );
      form.reset();
    } else apiFail(res);
  }

  async function syncApi(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setApiError(null);
    setApiOk(null);
    setSync(null);
    const year = Number(new FormData(e.currentTarget).get('year'));
    setSyncing(true);
    const res = await call<SyncResult>('/admin/holiday-api/sync', {
      method: 'POST',
      body: { year },
    });
    setSyncing(false);
    if (res.status === 200 && res.data) {
      setSync(res.data);
      setApiOk('Año consultado. Quedó como borrador: revíselo y publíquelo para usarlo.');
      await Promise.all([load(), loadApi()]);
    } else {
      apiFail(res);
      await loadApi();
    }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const days = parseLines(String(f.get('days') ?? ''));
    if (!days || days.length === 0) {
      setError('Escriba un festivo por línea con el formato AAAA-MM-DD;Nombre.');
      return;
    }
    const res = await call('/admin/holidays', {
      method: 'POST',
      body: {
        year: Number(f.get('year')),
        days,
        source: 'MANUAL',
        reason: String(f.get('reason') ?? ''),
      },
    });
    if (res.status === 201) {
      setOk('Borrador creado. Revíselo y publíquelo para que se use en los cálculos.');
      form.reset();
      await load();
    } else if (res.status === 400)
      setError(
        'Revise el año, que todas las fechas sean de ese año y sin repetir, y el motivo (mínimo 10 caracteres).',
      );
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  async function publish(id: string) {
    setError(null);
    setOk(null);
    const res = await call(`/admin/holidays/${id}/publish`, { method: 'POST', body: {} });
    if (res.status === 200) {
      setOk('Calendario publicado. La versión anterior del año quedó como reemplazada.');
      await load();
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <>
      <PageHeader title="Festivos" />
      <p className="muted">
        Sin un calendario publicado que cubra el intervalo y la fecha de retorno, no se calculan ni
        se aprueban vacaciones. Cada cambio crea una versión nueva; publicar una no altera lo ya
        aprobado.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      <section className="import-panel" aria-label="Servicio de festivos (API)">
        <h2>Servicio de festivos (API)</h2>
        <p className="muted">
          NOMFLOW consulta el servicio desde el servidor, año por año, y deja el resultado como
          borrador para su revisión; nunca cambia un calendario ya publicado. Si el servicio falla,
          se sigue usando el último calendario publicado.
        </p>
        {apiError ? <Notice kind="error">{apiError}</Notice> : null}
        {apiOk ? <Notice kind="ok">{apiOk}</Notice> : null}
        {api ? (
          <p>
            <strong>Estado:</strong>{' '}
            {api.configured
              ? `URL configurada; clave ${api.hasApiKey ? 'guardada' : 'sin guardar'}.`
              : 'Sin configurar.'}
            {api.lastSyncStatus
              ? ` Última consulta: año ${api.lastSyncYear}, ${SYNC_STATUS[api.lastSyncStatus] ?? api.lastSyncStatus}${api.lastSyncAt ? ` (${formatDate(api.lastSyncAt)})` : ''}.`
              : ''}
          </p>
        ) : null}
        <form onSubmit={saveApi} noValidate key={api?.updatedAt ?? 'sin-configurar'}>
          <Field
            label="URL del servicio (sin el año)"
            name="url"
            type="url"
            defaultValue={api?.url ?? ''}
            hint="Por ejemplo https://www.festivos.com.co/api/v1/festivos; se le agrega ?year=AAAA."
            required
            maxLength={300}
          />
          <PasswordField
            label="Clave del servicio (API KEY)"
            name="apiKey"
            autoComplete="new-password"
            hint={
              api?.hasApiKey
                ? 'Ya hay una clave guardada. Escriba una nueva solo si quiere reemplazarla.'
                : 'Se guarda cifrada y no se vuelve a mostrar.'
            }
          />
          {api?.hasApiKey ? (
            <label className="choice">
              <input type="checkbox" name="clearApiKey" />
              <span>Borrar la clave guardada</span>
            </label>
          ) : null}
          <button type="submit">Guardar configuración</button>
        </form>
        <form onSubmit={syncApi} className="toolbar" noValidate>
          <Field label="Año a consultar" name="year" type="number" required />
          <button type="submit" className="secondary" disabled={syncing || !api?.hasApiKey}>
            {syncing ? 'Consultando…' : 'Consultar el año'}
          </button>
        </form>
        {sync ? (
          <div aria-label="Resultado de la consulta">
            <p>
              Borrador versión {sync.version} del año {sync.year}: {sync.days} festivos.
            </p>
            {sync.hadPublished ? (
              <p className="muted">
                Frente al calendario publicado: {sync.added.length} nuevos
                {sync.added.length ? ` (${sync.added.join(', ')})` : ''} y {sync.removed.length} que
                ya no vienen{sync.removed.length ? ` (${sync.removed.join(', ')})` : ''}.
              </p>
            ) : (
              <p className="muted">Ese año todavía no tenía calendario publicado.</p>
            )}
          </div>
        ) : null}
      </section>

      <section className="import-panel" aria-label="Nuevo calendario">
        <h2>Nueva versión de un año</h2>
        <form onSubmit={create} noValidate>
          <div className="grid-2">
            <Field label="Año" name="year" type="number" required />
            <Field label="Motivo (mínimo 10 caracteres)" name="reason" required maxLength={300} />
          </div>
          <div className="field">
            <label htmlFor="festivos-dias">Festivos (uno por línea: AAAA-MM-DD;Nombre)</label>
            <textarea id="festivos-dias" name="days" rows={8} required />
          </div>
          <button type="submit">Crear borrador</button>
        </form>
      </section>

      {items === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Calendarios de festivos">
          <table>
            <caption className="muted">Calendarios de festivos por año y versión</caption>
            <thead>
              <tr>
                <th scope="col">Año</th>
                <th scope="col">Versión</th>
                <th scope="col">Estado</th>
                <th scope="col">Origen</th>
                <th scope="col">Festivos</th>
                <th scope="col">Publicado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{c.year}</td>
                  <td>{c.version}</td>
                  <td>
                    <Badge kind={c.status === 'PUBLICADO' ? 'ok' : 'off'}>{STATUS[c.status]}</Badge>
                  </td>
                  <td>{c.source}</td>
                  <td className="num">{c.days}</td>
                  <td>{c.publishedAt ? formatDate(c.publishedAt) : '—'}</td>
                  <td>
                    {c.status === 'BORRADOR' ? (
                      <button
                        type="button"
                        onClick={() => void publish(c.id)}
                        aria-label={`Publicar calendario ${c.year}, versión ${c.version}`}
                      >
                        Publicar
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    Todavía no hay calendarios de festivos.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
