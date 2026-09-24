'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice } from '@/components/admin-ui';
import { PermitInbox } from '@/components/permit-inbox';
import { VacationDetail } from '@/components/vacation-detail';
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

type Mode = 'manager' | 'final';

const WAITING: Record<Mode, string> = { manager: 'PENDIENTE_JEFE', final: 'PENDIENTE_FINAL' };
const kind = (s: string): 'ok' | 'warn' | 'off' =>
  s === 'APROBADA' ? 'ok' : OPEN.includes(s) ? 'warn' : 'off';

function Inbox({ mode }: { mode: Mode }) {
  const { call } = useAdmin();
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [panel, setPanel] = useState<'reject' | 'propose' | null>(null);

  const load = useCallback(async () => {
    const res = await call<RequestRow[]>(`/approvals/vacations/${mode}`);
    if (res.status === 200 && res.data) setRows(res.data);
    else setError(NETWORK_ERROR);
  }, [call, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    setError(null);
    setPanel(null);
    const res = await call<RequestDetail>(`/me/vacations/${id}`);
    if (res.status === 200 && res.data) setDetail(res.data);
    else setError(vacationError(res.status, res.data));
  }

  async function run(path: string, body: object, done: string) {
    if (!detail) return;
    setError(null);
    setOk(null);
    const res = await call(`/approvals/vacations/${mode}/${detail.id}/${path}`, {
      method: 'POST',
      body,
    });
    if (res.status === 200) {
      setOk(done);
      setDetail(null);
      setPanel(null);
      await load();
    } else setError(vacationError(res.status, res.data));
  }

  function reject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    void run('reject', { reason }, 'Solicitud rechazada con su motivo.');
  }

  function propose(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    const current = detail.revisions.find((r) => r.number === detail.revision);
    const allocations = (current?.allocations ?? []).map((a) => ({
      progVacId: a.progVacId,
      days: Number(f.get(`days-${a.progVacId}`)),
    }));
    void run(
      'propose',
      { start: String(f.get('start') ?? ''), allocations, reason: String(f.get('reason') ?? '') },
      'Cambio propuesto. El empleado debe aceptarlo antes de la aprobación final.',
    );
  }

  const current = detail?.revisions.find((r) => r.number === detail.revision);
  const canAct = detail?.status === WAITING[mode];

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {rows === null && !error ? <Loading>Consultando solicitudes…</Loading> : null}
      {rows !== null ? (
        rows.length === 0 ? (
          <EmptyState title="No hay solicitudes para revisar." />
        ) : (
          <ul className="vouchers">
            {rows.map((r) => (
              <li key={r.id}>
                <span>
                  <strong>{r.employee}</strong>
                  <span className="muted">
                    {' '}
                    - {longDate(r.start)} a {longDate(r.end)}, {r.businessDays} días hábiles
                  </span>{' '}
                  <Badge kind={kind(r.status)}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void open(r.id)}
                  aria-label={`Revisar la solicitud de ${r.employee} del ${longDate(r.start)}`}
                >
                  Revisar
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {detail ? (
        <section className="panel" aria-label="Revisión de la solicitud">
          <h2>Solicitud de {detail.employee}</h2>
          <VacationDetail detail={detail} />
          {canAct ? (
            <div className="toolbar">
              <button
                type="button"
                onClick={() =>
                  void run(
                    'approve',
                    {},
                    mode === 'final'
                      ? 'Aprobación final registrada: se descontaron los días y quedó el disfrute.'
                      : 'Solicitud aprobada; pasa a la aprobación final.',
                  )
                }
              >
                {mode === 'final' ? 'Aprobar y descontar' : 'Aprobar'}
              </button>
              <button type="button" className="secondary" onClick={() => setPanel('reject')}>
                Rechazar
              </button>
              {mode === 'manager' ? (
                <button type="button" className="secondary" onClick={() => setPanel('propose')}>
                  Proponer cambios
                </button>
              ) : null}
            </div>
          ) : (
            <p className="muted">Esta solicitud ya no espera su acción.</p>
          )}
          {panel === 'reject' ? (
            <form onSubmit={reject} noValidate aria-label="Rechazar solicitud">
              <div className="field">
                <label htmlFor="motivo-rechazo">Motivo del rechazo (mínimo 10 caracteres)</label>
                <textarea id="motivo-rechazo" name="reason" rows={3} maxLength={500} required />
              </div>
              <button type="submit">Confirmar rechazo</button>
            </form>
          ) : null}
          {panel === 'propose' && current ? (
            <form onSubmit={propose} noValidate aria-label="Proponer cambios">
              <Field
                label="Nueva fecha inicial (día hábil)"
                name="start"
                type="date"
                defaultValue={current.start}
                required
              />
              {current.allocations.map((a) => (
                <Field
                  key={a.progVacId}
                  label={`Días hábiles del período ${a.perIni} a ${a.perFin}`}
                  name={`days-${a.progVacId}`}
                  type="number"
                  min={1}
                  defaultValue={a.days}
                  required
                />
              ))}
              <div className="field">
                <label htmlFor="motivo-cambio">Motivo del cambio (mínimo 10 caracteres)</label>
                <textarea id="motivo-cambio" name="reason" rows={3} maxLength={500} required />
              </div>
              <button type="submit">Enviar propuesta al empleado</button>
            </form>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

export default function ApprovalsPage() {
  const { profile } = useAdmin();
  const isManager = profile.roles.some((r) => r.role === 'AREA_MANAGER');
  const isFinal = profile.roles.some((r) => r.role === 'VACATION_FINAL_APPROVER');
  const [mode, setMode] = useState<Mode>(isManager ? 'manager' : 'final');
  // Los permisos solo los decide el jefe de área; el aprobador final no interviene.
  const [topic, setTopic] = useState<'vacaciones' | 'permisos'>('vacaciones');

  if (!isManager && !isFinal)
    return (
      <section className="panel narrow">
        <h1>Acceso restringido</h1>
        <p>Esta área es solo para jefes de área y aprobadores de vacaciones.</p>
        <div className="links">
          <Link href="/">Volver al inicio</Link>
        </div>
      </section>
    );

  return (
    <>
      <div className="page-head">
        <h1>Aprobaciones</h1>
        <p className="muted">
          Cada aprobación exige el rol vigente y confirmar su clave. La aprobación final de
          vacaciones descuenta los días disponibles; los permisos solo los decide el jefe de área.
        </p>
      </div>
      {isManager ? (
        <div role="tablist" aria-label="Tipo de solicitud" className="toolbar">
          <button
            type="button"
            role="tab"
            aria-selected={topic === 'vacaciones'}
            className={topic === 'vacaciones' ? '' : 'secondary'}
            onClick={() => setTopic('vacaciones')}
          >
            Vacaciones
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={topic === 'permisos'}
            className={topic === 'permisos' ? '' : 'secondary'}
            onClick={() => setTopic('permisos')}
          >
            Permisos
          </button>
        </div>
      ) : null}
      {topic === 'permisos' && isManager ? <PermitInbox /> : null}
      {topic === 'vacaciones' && isManager && isFinal ? (
        <div role="tablist" aria-label="Bandeja" className="toolbar">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'manager'}
            className={mode === 'manager' ? '' : 'secondary'}
            onClick={() => setMode('manager')}
          >
            Como jefe de área
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'final'}
            className={mode === 'final' ? '' : 'secondary'}
            onClick={() => setMode('final')}
          >
            Aprobación final
          </button>
        </div>
      ) : null}
      {topic === 'vacaciones' || !isManager ? <Inbox key={mode} mode={mode} /> : null}
      <div className="links">
        <Link href="/">Volver al inicio</Link>
      </div>
    </>
  );
}
