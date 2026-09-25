'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice } from '@/components/admin-ui';
import { VacationDetail, RevisionSummary } from '@/components/vacation-detail';
import { Alert, EmptyState, Field, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import {
  OPEN,
  STATUS_LABEL,
  longDate,
  vacationError,
  type RequestDetail,
  type RequestRow,
} from '@/lib/vacations';

interface Period {
  id: string;
  perIni: string;
  perFin: string;
  dias: number;
  disp: number;
}

interface Plan {
  start: string;
  end: string;
  businessDays: number;
  calendarDiff: number;
  returnDate: string;
  holidaysInRange: string[];
}

const kind = (s: string): 'ok' | 'warn' | 'off' =>
  s === 'APROBADA' ? 'ok' : OPEN.includes(s) ? 'warn' : 'off';

export default function MyVacationsPage() {
  const { call } = useAdmin();
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, string>>({});
  const [start, setStart] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      call<Period[]>('/me/vacations/periods'),
      call<RequestRow[]>('/me/vacations'),
    ]);
    if (p.status === 200 && p.data && r.status === 200 && r.data) {
      setPeriods(p.data);
      setRequests(r.data);
    } else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const allocations = () =>
    Object.entries(days)
      .filter(([, v]) => v !== '' && Number(v) > 0)
      .map(([progVacId, v]) => ({ progVacId, days: Number(v) }));

  async function calculate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setOk(null);
    setPlan(null);
    const a = allocations();
    if (a.length === 0)
      return setFormError('Elija al menos un período e indique cuántos días hábiles va a tomar.');
    if (!start) return setFormError('Elija la fecha inicial del disfrute.');
    const res = await call<Plan>('/me/vacations/preview', {
      method: 'POST',
      body: { start, allocations: a },
    });
    if (res.status === 200 && res.data) setPlan(res.data);
    else setFormError(vacationError(res.status, res.data));
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    const res = await call<{ id: string }>('/me/vacations', {
      method: 'POST',
      body: { start, allocations: allocations() },
    });
    setBusy(false);
    if (res.status === 201) {
      setOk(
        'Solicitud enviada. Su jefe de área la revisará; mientras tanto no se descuenta ningún día.',
      );
      setPlan(null);
      setDays({});
      setStart('');
      await load();
    } else setFormError(vacationError(res.status, res.data));
  }

  async function open(id: string) {
    setError(null);
    const res = await call<RequestDetail>(`/me/vacations/${id}`);
    if (res.status === 200 && res.data) setDetail(res.data);
    else setError(vacationError(res.status, res.data));
  }

  async function act(id: string, action: 'accept' | 'cancel') {
    setError(null);
    setOk(null);
    const res = await call(`/me/vacations/${id}/${action}`, { method: 'POST', body: {} });
    if (res.status === 200) {
      setOk(
        action === 'accept'
          ? 'Cambio aceptado. Sigue a la aprobación final.'
          : 'Solicitud cancelada.',
      );
      setDetail(null);
      await load();
    } else setError(vacationError(res.status, res.data));
  }

  const hasOpenWork = requests?.some((r) => r.status === 'REVISION_EMPLEADO');

  return (
    <>
      <div className="page-head">
        <h1>Mis vacaciones</h1>
        <p className="muted">
          Solicite sus vacaciones eligiendo los períodos y los días hábiles. Los días solo se
          descuentan cuando la solicitud tiene la aprobación final.
        </p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {periods === null && !error ? <Loading>Consultando sus vacaciones…</Loading> : null}

      {periods !== null ? (
        <section className="panel" aria-label="Nueva solicitud">
          <h2>Nueva solicitud</h2>
          {periods.length === 0 ? (
            <EmptyState title="No tiene períodos de vacaciones con días disponibles.">
              <p>Si cree que es un error, consulte con Gestión Humana.</p>
            </EmptyState>
          ) : (
            <form onSubmit={calculate} noValidate>
              <fieldset>
                <legend>Períodos y días hábiles que va a tomar</legend>
                {periods.map((p) => (
                  <div className="field" key={p.id}>
                    <label htmlFor={`dias-${p.id}`}>
                      Período {longDate(p.perIni)} a {longDate(p.perFin)}: {p.dias} días, {p.disp}{' '}
                      disponibles. Días a tomar
                    </label>
                    <input
                      id={`dias-${p.id}`}
                      type="number"
                      min={0}
                      max={p.disp}
                      inputMode="numeric"
                      value={days[p.id] ?? ''}
                      onChange={(e) => setDays({ ...days, [p.id]: e.target.value })}
                    />
                  </div>
                ))}
              </fieldset>
              <Field
                label="Fecha inicial del disfrute (día hábil)"
                name="start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                required
              />
              {formError ? <Alert kind="error">{formError}</Alert> : null}
              <button type="submit" className="secondary">
                Calcular fechas
              </button>
            </form>
          )}
          {plan ? (
            <section aria-label="Fechas calculadas">
              <h3>Fechas calculadas</h3>
              <RevisionSummary rev={plan} />
              {plan.holidaysInRange.length > 0 ? (
                <p className="muted">
                  Festivos dentro del intervalo (no consumen días):{' '}
                  {plan.holidaysInRange.map(longDate).join(', ')}.
                </p>
              ) : null}
              <p>
                Al enviar, usted acepta estas fechas: {plan.businessDays} días hábiles desde el{' '}
                {longDate(plan.start)}, con retorno el {longDate(plan.returnDate)}.
              </p>
              <button type="button" onClick={() => void submit()} disabled={busy}>
                {busy ? 'Enviando…' : 'Aceptar y enviar solicitud'}
              </button>
            </section>
          ) : null}
        </section>
      ) : null}

      {requests !== null ? (
        <section className="panel" aria-label="Mis solicitudes">
          <h2>Mis solicitudes</h2>
          {hasOpenWork ? (
            <Notice kind="ok">
              Tiene un cambio propuesto por su jefe que espera su respuesta.
            </Notice>
          ) : null}
          {requests.length === 0 ? (
            <EmptyState title="Todavía no ha enviado solicitudes." />
          ) : (
            <ul className="vouchers">
              {requests.map((r) => (
                <li key={r.id}>
                  <span>
                    <strong>
                      {longDate(r.start)} a {longDate(r.end)}
                    </strong>{' '}
                    <span className="muted">
                      - {r.businessDays} días hábiles, retorno {longDate(r.returnDate)}
                    </span>{' '}
                    <Badge kind={kind(r.status)}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                  </span>
                  <span className="toolbar">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void open(r.id)}
                      aria-label={`Ver detalle de la solicitud del ${longDate(r.start)}`}
                    >
                      Ver detalle
                    </button>
                    {r.status === 'REVISION_EMPLEADO' ? (
                      <button type="button" onClick={() => void act(r.id, 'accept')}>
                        Aceptar el cambio
                      </button>
                    ) : null}
                    {r.status === 'APROBADA' ? (
                      <a
                        className="button secondary"
                        href={`/api/me/vacations/${r.id}/pdf`}
                        download
                        aria-label={`Descargar la constancia de la solicitud del ${longDate(r.start)}`}
                      >
                        Constancia (PDF)
                      </a>
                    ) : null}
                    {r.status === 'APROBADA' && r.documentArchived ? (
                      <span className="muted">
                        Archivo histórico: la descarga puede tardar unos segundos.
                      </span>
                    ) : null}
                    {OPEN.includes(r.status) ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void act(r.id, 'cancel')}
                      >
                        Cancelar solicitud
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {detail ? <VacationDetail detail={detail} /> : null}
        </section>
      ) : null}

      <div className="links">
        <Link href="/">Volver al inicio</Link>
      </div>
    </>
  );
}
