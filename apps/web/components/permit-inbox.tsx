'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice } from '@/components/admin-ui';
import { PermitDetailView } from '@/components/permit-detail';
import { Alert, EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import {
  PERMIT_STATUS,
  permitError,
  permitWhen,
  type PermitDetail,
  type PermitRow,
} from '@/lib/permits';
import { longDate } from '@/lib/vacations';

const kind = (s: string): 'ok' | 'warn' | 'off' =>
  s === 'APROBADO' ? 'ok' : s === 'PENDIENTE_JEFE' ? 'warn' : 'off';

/** Permisos de las personas cuyo jefe de área es el usuario: solo él aprueba o rechaza. */
export function PermitInbox() {
  const { call } = useAdmin();
  const [rows, setRows] = useState<PermitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [detail, setDetail] = useState<PermitDetail | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(async () => {
    const res = await call<PermitRow[]>('/approvals/permits/manager');
    if (res.status === 200 && res.data) setRows(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    setError(null);
    setRejecting(false);
    const res = await call<PermitDetail>(`/me/permits/${id}`);
    if (res.status === 200 && res.data) setDetail(res.data);
    else setError(permitError(res.status, res.data));
  }

  async function run(path: 'approve' | 'reject', body: object, done: string) {
    if (!detail) return;
    setError(null);
    setOk(null);
    const res = await call(`/approvals/permits/manager/${detail.id}/${path}`, {
      method: 'POST',
      body,
    });
    if (res.status === 200) {
      setOk(done);
      setDetail(null);
      setRejecting(false);
      await load();
    } else setError(permitError(res.status, res.data));
  }

  function reject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    void run('reject', { reason }, 'Permiso rechazado con su motivo.');
  }

  return (
    <>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {rows === null && !error ? <Loading>Consultando permisos…</Loading> : null}
      {rows !== null ? (
        rows.length === 0 ? (
          <EmptyState title="No hay permisos para revisar." />
        ) : (
          <ul className="vouchers">
            {rows.map((r) => (
              <li key={r.id}>
                <span>
                  <strong>{r.employee}</strong>
                  <span className="muted">
                    {' '}
                    - {r.typeName}, {permitWhen(r, longDate)}
                  </span>{' '}
                  <Badge kind={kind(r.status)}>{PERMIT_STATUS[r.status] ?? r.status}</Badge>
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void open(r.id)}
                  aria-label={`Revisar el permiso de ${r.employee}, ${r.typeName} del ${longDate(r.start)}`}
                >
                  Revisar
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {detail ? (
        <section className="panel" aria-label="Revisión del permiso">
          <h2>Permiso de {detail.employee}</h2>
          <PermitDetailView detail={detail} />
          {detail.status === 'PENDIENTE_JEFE' ? (
            <div className="toolbar">
              <button
                type="button"
                onClick={() =>
                  void run('approve', {}, 'Permiso aprobado. No requiere más aprobaciones.')
                }
              >
                Aprobar
              </button>
              <button type="button" className="secondary" onClick={() => setRejecting(true)}>
                Rechazar
              </button>
            </div>
          ) : (
            <p className="muted">Este permiso ya no espera su decisión.</p>
          )}
          {rejecting ? (
            <form onSubmit={reject} noValidate aria-label="Rechazar permiso">
              <div className="field">
                <label htmlFor="permiso-rechazo">Motivo del rechazo (mínimo 10 caracteres)</label>
                <textarea id="permiso-rechazo" name="reason" rows={3} maxLength={500} required />
              </div>
              <button type="submit">Confirmar rechazo</button>
            </form>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
