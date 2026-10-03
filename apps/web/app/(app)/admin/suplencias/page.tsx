'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Modal, Notice, PageHeader, Pager, SelectField } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import {
  PHASE_LABEL,
  dateLabel,
  phaseKind,
  substitutionError,
  type Substitution,
} from '@/lib/substitutions';

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Substitution[];
}

/** Gestión Humana consulta todas las suplencias de quienes aprueban y puede anularlas. */
export default function SubstitutionsAdminPage() {
  const { call } = useAdmin();
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [annulling, setAnnulling] = useState<Substitution | null>(null);
  const [annulError, setAnnulError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q) qs.set('q', q);
    if (status) qs.set('status', status);
    const res = await call<Page>(`/admin/substitutions?${qs.toString()}`);
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
    setError(null);
    setAnnulError(null);
    setOk(null);
    const res = await call(`/admin/substitutions/${annulling.id}/annul`, {
      method: 'POST',
      body: { reason },
    });
    if (res.status === 204) {
      setOk('Suplencia anulada. Quien aprueba vuelve a decidir lo suyo.');
      setAnnulling(null);
      await load();
    } else setAnnulError(substitutionError(res.status, res.data, NETWORK_ERROR));
  }

  return (
    <>
      <PageHeader title="Suplencias de quienes aprueban" />
      <p className="muted">
        Todas las suplencias designadas por jefes, directores, gerentes y aprobadores finales. Una
        suplencia vigente se puede anular con un motivo; queda en la auditoría.
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
            { value: 'ACTIVA', label: 'Activas' },
            { value: 'TERMINADA', label: 'Terminadas por el titular' },
            { value: 'ANULADA', label: 'Anuladas' },
          ]}
        />
        <button type="submit">Filtrar</button>
      </form>

      {data === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : data.items.length === 0 ? (
        <p className="muted">No hay suplencias con esos filtros.</p>
      ) : (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Suplencias">
            <table>
              <caption className="muted">{data.total} suplencias</caption>
              <thead>
                <tr>
                  <th scope="col">Titular</th>
                  <th scope="col">Suplente</th>
                  <th scope="col">Desde</th>
                  <th scope="col">Hasta</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.titular}</td>
                    <td>{s.substitute}</td>
                    <td>{dateLabel(s.validFrom)}</td>
                    <td>{dateLabel(s.validTo)}</td>
                    <td>
                      <Badge kind={phaseKind(s.phase)}>{PHASE_LABEL[s.phase]}</Badge>
                      {s.endReason ? <span className="muted"> {s.endReason}</span> : null}
                    </td>
                    <td>
                      {s.status === 'ACTIVA' && s.phase !== 'VENCIDA' ? (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`Anular la suplencia de ${s.titular} por ${s.substitute}`}
                          onClick={() => {
                            setAnnulError(null);
                            setAnnulling(s);
                          }}
                        >
                          Anular
                        </button>
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
        <Modal title="Anular la suplencia" onClose={() => setAnnulling(null)}>
          <form onSubmit={(e) => void annul(e)} noValidate>
            {annulError ? <Notice kind="error">{annulError}</Notice> : null}
            <p>
              {annulling.substitute} dejará de decidir por {annulling.titular}, y{' '}
              {annulling.titular} volverá a decidir lo suyo.
            </p>
            <Field label="Motivo (mínimo 10 caracteres)" name="reason" required maxLength={500} />
            <div className="toolbar">
              <button type="submit" className="danger">
                Anular suplencia
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
