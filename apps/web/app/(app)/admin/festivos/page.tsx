'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
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

  const load = useCallback(async () => {
    const res = await call<Calendar[]>('/admin/holidays');
    if (res.status === 200 && res.data) setItems(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

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
