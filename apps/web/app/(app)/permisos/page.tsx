'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice } from '@/components/admin-ui';
import { PermitDetailView } from '@/components/permit-detail';
import { Alert, EmptyState, Field, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import {
  PERMIT_STATUS,
  permitError,
  permitWhen,
  type PermitDetail,
  type PermitRow,
  type PermitType,
} from '@/lib/permits';
import { longDate } from '@/lib/vacations';

const kind = (s: string): 'ok' | 'warn' | 'off' =>
  s === 'APROBADO' ? 'ok' : s === 'PENDIENTE_JEFE' ? 'warn' : 'off';

export default function MyPermitsPage() {
  const { call, send } = useAdmin();
  const [types, setTypes] = useState<PermitType[] | null>(null);
  const [rows, setRows] = useState<PermitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [typeId, setTypeId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [detail, setDetail] = useState<PermitDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      call<PermitType[]>('/me/permits/types'),
      call<PermitRow[]>('/me/permits'),
    ]);
    if (t.status === 200 && t.data && r.status === 200 && r.data) {
      setTypes(t.data);
      setRows(r.data);
    } else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const type = types?.find((t) => t.id === typeId);
  const oneDay = start !== '' && start === end;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setOk(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    if (!typeId) return setFormError('Elija el tipo de permiso.');
    if (!start || !end) return setFormError('Indique la fecha inicial y la final.');
    data.set('typeId', typeId);
    data.set('start', start);
    data.set('end', end);
    if (!(type?.allowsHours && oneDay)) {
      data.delete('startTime');
      data.delete('endTime');
    }
    const file = data.get('support');
    if (file instanceof File && file.size === 0) data.delete('support');
    setBusy(true);
    const res = await send<{ id: string }>('/me/permits', data);
    setBusy(false);
    if (res.status === 201) {
      setOk('Permiso enviado. Su jefe de área lo revisará y le responderá aquí.');
      form.reset();
      setTypeId('');
      setStart('');
      setEnd('');
      await load();
    } else setFormError(permitError(res.status, res.data));
  }

  async function open(id: string) {
    setError(null);
    const res = await call<PermitDetail>(`/me/permits/${id}`);
    if (res.status === 200 && res.data) setDetail(res.data);
    else setError(permitError(res.status, res.data));
  }

  async function cancel(id: string) {
    setError(null);
    setOk(null);
    const res = await call(`/me/permits/${id}/cancel`, { method: 'POST', body: {} });
    if (res.status === 200) {
      setOk('Permiso cancelado.');
      setDetail(null);
      await load();
    } else setError(permitError(res.status, res.data));
  }

  return (
    <>
      <div className="page-head">
        <h1>Mis permisos</h1>
        <p className="muted">
          Solicite un permiso a su jefe de área. Los permisos no descuentan sus días de vacaciones.
        </p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {types === null && !error ? <Loading>Consultando sus permisos…</Loading> : null}

      {types !== null ? (
        <section className="panel" aria-label="Nueva solicitud de permiso">
          <h2>Nueva solicitud</h2>
          {types.length === 0 ? (
            <EmptyState title="Todavía no hay tipos de permiso disponibles.">
              <p>Gestión Humana debe configurarlos.</p>
            </EmptyState>
          ) : (
            <form onSubmit={submit} noValidate>
              <div className="field">
                <label htmlFor="permiso-tipo">Tipo de permiso</label>
                <select
                  id="permiso-tipo"
                  value={typeId}
                  onChange={(e) => setTypeId(e.target.value)}
                >
                  <option value="">Elija un tipo</option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {type ? (
                  <p className="hint">
                    {[
                      type.description,
                      type.maxDays ? `Máximo ${type.maxDays} días.` : null,
                      type.supportRequired ? 'Exige adjuntar un soporte.' : null,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  </p>
                ) : null}
              </div>
              <div className="grid-2">
                <Field
                  label="Fecha inicial"
                  name="startDate"
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    if (!end || end < e.target.value) setEnd(e.target.value);
                  }}
                  required
                />
                <Field
                  label="Fecha final"
                  name="endDate"
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  required
                />
              </div>
              {type?.allowsHours && oneDay ? (
                <div className="grid-2">
                  <Field label="Hora inicial (opcional)" name="startTime" type="time" />
                  <Field label="Hora final (opcional)" name="endTime" type="time" />
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="permiso-just">Justificación (mínimo 10 caracteres)</label>
                <textarea
                  id="permiso-just"
                  name="justification"
                  rows={3}
                  maxLength={1000}
                  required
                />
              </div>
              <Field
                label={type?.supportRequired ? 'Soporte (PDF, PNG o JPEG, máx. 2 MB)' : 'Soporte'}
                name="support"
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                optional={!type?.supportRequired}
                required={Boolean(type?.supportRequired)}
              />
              {formError ? <Alert kind="error">{formError}</Alert> : null}
              <button type="submit" disabled={busy}>
                {busy ? 'Enviando…' : 'Enviar solicitud'}
              </button>
            </form>
          )}
        </section>
      ) : null}

      {rows !== null ? (
        <section className="panel" aria-label="Mis solicitudes de permiso">
          <h2>Mis solicitudes</h2>
          {rows.length === 0 ? (
            <EmptyState title="Todavía no ha enviado permisos." />
          ) : (
            <ul className="vouchers">
              {rows.map((r) => (
                <li key={r.id}>
                  <span>
                    <strong>{r.typeName}</strong>
                    <span className="muted"> - {permitWhen(r, longDate)}</span>{' '}
                    <Badge kind={kind(r.status)}>{PERMIT_STATUS[r.status] ?? r.status}</Badge>
                  </span>
                  <span className="toolbar">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void open(r.id)}
                      aria-label={`Ver detalle del permiso ${r.typeName} del ${longDate(r.start)}`}
                    >
                      Ver detalle
                    </button>
                    {r.status === 'PENDIENTE_JEFE' ? (
                      <button type="button" className="secondary" onClick={() => void cancel(r.id)}>
                        Cancelar solicitud
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {detail ? <PermitDetailView detail={detail} /> : null}
        </section>
      ) : null}

      <div className="links">
        <Link href="/">Volver al inicio</Link>
      </div>
    </>
  );
}
