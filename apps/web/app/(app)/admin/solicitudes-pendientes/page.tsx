'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Notice, PageHeader } from '@/components/admin-ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import { longDate } from '@/lib/vacations';

interface Row {
  id: string;
  employee: string;
  nIde: string;
  start: string | null;
  end: string | null;
  businessDays: number | null;
  assignedTo: string;
  assignedRole: string;
  currentApprover: string | null;
  currentRole: string | null;
  state: 'VIGENTE' | 'REASIGNABLE' | 'SIN_APROBADOR';
}

const ROLE: Record<string, string> = {
  AREA_MANAGER: 'Jefe de área',
  AREA_DIRECTOR: 'Director de área',
  GENERAL_MANAGER: 'Gerente general',
};

const ERRORS: Record<string, string> = {
  NO_MANAGER:
    'El área no tiene hoy un único aprobador vigente. Designe primero al jefe o al director del área.',
  ALREADY_CURRENT: 'La solicitud ya la tiene quien corresponde.',
  INVALID_STATE: 'La solicitud ya no está esperando el primer visto bueno.',
};

/** Gestión Humana ve quién tiene cada solicitud pendiente del primer visto bueno y la reasigna si el área cambió de jefe. */
export default function PendingApprovalPage() {
  const { call } = useAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await call<Row[]>('/admin/vacations/pending-approval');
    if (res.status === 200 && res.data) {
      setRows(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reassign(r: Row) {
    setError(null);
    setOk(null);
    setBusy(r.id);
    const res = await call(`/admin/vacations/${r.id}/reassign`, { method: 'POST', body: {} });
    setBusy(null);
    if (res.status === 204) {
      setOk(`La solicitud de ${r.employee} pasó a ${r.currentApprover ?? 'el aprobador vigente'}.`);
      await load();
    } else if (res.status === 403 && !(res.data as { code?: string } | null)?.code)
      setError('Se canceló la confirmación de identidad.');
    else {
      setError(ERRORS[(res.data as { code?: string } | null)?.code ?? ''] ?? NETWORK_ERROR);
      await load();
    }
  }

  const stale = rows?.filter((r) => r.state !== 'VIGENTE').length ?? 0;

  return (
    <>
      <PageHeader title="Solicitudes pendientes del primer visto bueno" />
      <p className="muted">
        Una solicitud de vacaciones queda asignada a quien era el aprobador del área cuando se
        envió. Si el área cambió de jefe, el nuevo no la ve y el anterior ya no puede decidirla:
        aquí se pasa a quien corresponde hoy. Queda en el historial de la solicitud y en la
        auditoría.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      {rows === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : rows.length === 0 ? (
        <p className="muted">No hay solicitudes esperando el primer visto bueno.</p>
      ) : (
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Solicitudes pendientes del primer visto bueno"
        >
          <table>
            <caption className="muted">
              {rows.length} solicitudes; {stale} necesitan atención
            </caption>
            <thead>
              <tr>
                <th scope="col">Empleado</th>
                <th scope="col">Fechas</th>
                <th scope="col">Asignada a</th>
                <th scope="col">Aprobador vigente</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.employee} <span className="muted">({r.nIde})</span>
                  </td>
                  <td>
                    {longDate(r.start)} al {longDate(r.end)}
                  </td>
                  <td>
                    {r.assignedTo}{' '}
                    <span className="muted">({ROLE[r.assignedRole] ?? r.assignedRole})</span>
                  </td>
                  <td>
                    {r.currentApprover ? (
                      <>
                        {r.currentApprover}{' '}
                        <span className="muted">
                          ({ROLE[r.currentRole ?? ''] ?? r.currentRole})
                        </span>
                      </>
                    ) : (
                      <span className="muted">Ninguno</span>
                    )}
                  </td>
                  <td>
                    {r.state === 'VIGENTE' ? (
                      <Badge kind="ok">Al día</Badge>
                    ) : r.state === 'REASIGNABLE' ? (
                      <Badge kind="warn">Aprobador cambió</Badge>
                    ) : (
                      <Badge kind="off">Sin aprobador</Badge>
                    )}
                  </td>
                  <td>
                    {r.state === 'REASIGNABLE' ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy === r.id}
                        aria-label={`Reasignar la solicitud de ${r.employee} a ${r.currentApprover}`}
                        onClick={() => void reassign(r)}
                      >
                        {busy === r.id ? 'Reasignando…' : 'Reasignar'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
