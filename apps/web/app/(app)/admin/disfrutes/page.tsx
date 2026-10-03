'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Modal, Notice, PageHeader, Pager, SelectField } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import { longDate } from '@/lib/vacations';

interface Row {
  id: string;
  nIde: string;
  employee: string;
  status: 'APROBADA' | 'ANULADA';
  start: string;
  end: string;
  calendarDiff: number;
  businessDays: number;
  returnDate: string;
  approvedAt: string;
  annulledAt: string | null;
  annulReason: string | null;
  canAnnul: boolean;
  allocations: { perIni: string; perFin: string; days: number }[];
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Row[];
}

const ERRORS: Record<string, string> = {
  REASON_REQUIRED: 'Escriba un motivo de al menos 10 caracteres.',
  NOT_APPROVED: 'Solo se anula un disfrute aprobado.',
  ALREADY_ANNULLED: 'Ese disfrute ya está anulado.',
  ENDED: 'El disfrute ya terminó: no se puede anular.',
  PERIOD_GONE:
    'No se encontró el período de PROG_VAC de donde se descontaron los días. Ajústelo primero en Períodos de vacaciones.',
};

/** Gestión Humana consulta los disfrutes aprobados y anula uno que aún no terminó. */
export default function ApprovedVacationsPage() {
  const { call } = useAdmin();
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [annulling, setAnnulling] = useState<Row | null>(null);
  const [annulError, setAnnulError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q) qs.set('q', q);
    if (status) qs.set('status', status);
    const res = await call<Page>(`/admin/vacations/approved?${qs.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(res.status === 400 ? 'Revise los filtros.' : NETWORK_ERROR);
  }, [call, page, q, status]);

  useEffect(() => {
    void load();
  }, [load]);

  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setQ(String(new FormData(e.currentTarget).get('q') ?? '').trim());
    setPage(1);
  }

  async function annul(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!annulling) return;
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    setAnnulError(null);
    setOk(null);
    const res = await call(`/admin/vacations/${annulling.id}/annul`, {
      method: 'POST',
      body: { reason },
    });
    if (res.status === 204) {
      setOk(
        'Disfrute anulado. Los días volvieron a los períodos y la constancia ya no se entrega.',
      );
      setAnnulling(null);
      await load();
    } else if (res.status === 403 && !(res.data as { code?: string } | null)?.code)
      setAnnulError('Se canceló la confirmación de identidad.');
    else setAnnulError(ERRORS[(res.data as { code?: string } | null)?.code ?? ''] ?? NETWORK_ERROR);
  }

  return (
    <>
      <PageHeader title="Disfrutes aprobados" />
      <p className="muted">
        Disfrutes de vacaciones ya aprobados. Si hubo un error, se puede anular mientras el disfrute
        no haya terminado: los días vuelven a los períodos de donde se descontaron, la constancia
        deja de entregarse y el empleado puede solicitar de nuevo. Queda en la auditoría con el
        motivo.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      <form className="filters" onSubmit={filter} noValidate>
        <Field
          label="Buscar por nombre o identificación"
          name="q"
          defaultValue={q}
          maxLength={100}
        />
        <SelectField
          label="Estado"
          name="status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todos' },
            { value: 'APROBADA', label: 'Aprobados' },
            { value: 'ANULADA', label: 'Anulados' },
          ]}
        />
        <button type="submit">Filtrar</button>
      </form>

      {data === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : data.items.length === 0 ? (
        <p className="muted">No hay disfrutes con esos filtros.</p>
      ) : (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Disfrutes aprobados">
            <table>
              <caption className="muted">{data.total} disfrutes</caption>
              <thead>
                <tr>
                  <th scope="col">Empleado</th>
                  <th scope="col">Inicio</th>
                  <th scope="col">Fin</th>
                  <th scope="col">Días hábiles</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.employee} <span className="muted">({r.nIde})</span>
                    </td>
                    <td>{longDate(r.start)}</td>
                    <td>{longDate(r.end)}</td>
                    <td>{r.businessDays}</td>
                    <td>
                      <Badge kind={r.status === 'APROBADA' ? 'ok' : 'off'}>
                        {r.status === 'APROBADA' ? 'Aprobado' : 'Anulado'}
                      </Badge>
                      {r.annulReason ? <span className="muted"> {r.annulReason}</span> : null}
                    </td>
                    <td>
                      {r.canAnnul ? (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Anular el disfrute de ${r.employee} que empieza el ${longDate(r.start)}`}
                          onClick={() => {
                            setAnnulError(null);
                            setAnnulling(r);
                          }}
                        >
                          Anular
                        </button>
                      ) : r.status === 'APROBADA' ? (
                        <span className="muted">Ya terminó</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}

      {annulling ? (
        <Modal title="Anular el disfrute" onClose={() => setAnnulling(null)}>
          <form onSubmit={(e) => void annul(e)} noValidate>
            {annulError ? <Notice kind="error">{annulError}</Notice> : null}
            <p>
              Disfrute de {annulling.employee} del {longDate(annulling.start)} al{' '}
              {longDate(annulling.end)}. Se devolverán {annulling.businessDays} días hábiles:
            </p>
            <ul>
              {annulling.allocations.map((a) => (
                <li key={`${a.perIni}-${a.perFin}`}>
                  {a.days} {a.days === 1 ? 'día' : 'días'} al período {longDate(a.perIni)} a{' '}
                  {longDate(a.perFin)}
                </li>
              ))}
            </ul>
            <Field label="Motivo (mínimo 10 caracteres)" name="reason" required maxLength={500} />
            <div className="toolbar">
              <button type="submit" className="danger">
                Anular disfrute
              </button>
              <button type="button" className="secondary" onClick={() => setAnnulling(null)}>
                Cancelar
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
