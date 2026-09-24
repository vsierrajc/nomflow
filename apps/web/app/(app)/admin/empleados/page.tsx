'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Modal,
  Notice,
  PageHeader,
  Pager,
  SelectField,
  formatDate,
} from '@/components/admin-ui';
import { EmployeeAccount } from '@/components/employee-account';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Row {
  id: string;
  nIde: string;
  nCont: string;
  nombre: string;
  email: string;
  est: 'V' | 'C';
  cEmp: string | null;
  cArea: string | null;
  area: string | null;
  cargo: string | null;
  source: string;
  version: number;
  hasAccount: boolean;
}

interface Detail extends Row {
  nombres: string | null;
  apellidos: string | null;
  cCos: string | null;
  cCar: string | null;
  tipoContrato: string | null;
  fIni: string | null;
  fecNac: string | null;
  sAct: string | null;
  hliq: string | null;
  sexo: string | null;
  turno: string | null;
  celular: string | null;
  profesion: string | null;
  nivelEducativo: string | null;
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Row[];
}

interface HistoryRow {
  action: string;
  reason: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  at: string;
  by: string;
}

const PAGE_SIZE = 25;
const ACTIONS: Record<string, string> = {
  CREATE: 'Alta',
  UPDATE: 'Modificación',
  DEACTIVATE: 'Baja',
  REACTIVATE: 'Reactivación',
};
const FIELD_LABELS: Record<string, string> = {
  nombre: 'Nombre',
  nombres: 'Nombres',
  apellidos: 'Apellidos',
  email: 'Correo',
  est: 'Estado',
  cEmp: 'Empresa',
  cArea: 'Área',
  area: 'Descripción del área',
  cCos: 'Centro de costo',
  cCosto: 'Descripción del centro de costo',
  cCar: 'Cargo',
  cargo: 'Descripción del cargo',
  tipoContrato: 'Tipo de contrato',
  fIni: 'Fecha de inicio',
  fecNac: 'Fecha de nacimiento',
  sAct: 'Salario actual',
  hliq: 'HLIQ',
  sexo: 'Sexo',
  turno: 'Turno',
  celular: 'Celular',
  profesion: 'Profesión',
  nivelEducativo: 'Nivel educativo',
};

const ISSUE_HELP = 'Revise los campos marcados.';

function EmployeeForm({
  employee,
  onDone,
  onClose,
}: {
  employee: Detail | null;
  onDone: (m: string) => void;
  onClose: () => void;
}) {
  const { call } = useAdmin();
  const [est, setEst] = useState<'V' | 'C'>(employee?.est ?? 'V');
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    const nullable = (k: string) => (v(k) === '' ? null : v(k));
    const body = {
      cEmp: v('cEmp'),
      nombre: v('nombre'),
      nombres: nullable('nombres'),
      apellidos: nullable('apellidos'),
      email: v('email'),
      est,
      cArea: v('cArea'),
      cCos: nullable('cCos'),
      cCar: nullable('cCar'),
      tipoContrato: v('tipoContrato'),
      fIni: v('fIni'),
      fecNac: nullable('fecNac'),
      sAct: nullable('sAct'),
      hliq: nullable('hliq'),
      sexo: nullable('sexo'),
      turno: nullable('turno'),
      celular: nullable('celular'),
      profesion: nullable('profesion'),
      nivelEducativo: nullable('nivelEducativo'),
      reason: v('reason'),
    };
    setBusy(true);
    setError(null);
    setIssues([]);
    const res = employee
      ? await call<{ code?: string; issues?: string[] }>(`/admin/employees/${employee.id}`, {
          method: 'PUT',
          body: { ...body, version: employee.version },
        })
      : await call<{ code?: string; issues?: string[] }>('/admin/employees', {
          method: 'POST',
          body: { ...body, nIde: v('nIde'), nCont: v('nCont') },
        });
    setBusy(false);
    if (res.status === 200 || res.status === 201)
      onDone(employee ? 'Empleado actualizado.' : 'Empleado creado.');
    else if (res.status === 422) {
      setError(`Hay datos que no cumplen las reglas. ${ISSUE_HELP}`);
      setIssues(res.data?.issues ?? []);
    } else if (res.status === 409)
      setError('Otra persona modificó este registro. Cierre y vuelva a abrirlo.');
    else if (res.status === 400)
      setError(
        'Revise los datos: fechas AAAA-MM-DD, correo válido y un motivo de al menos 10 caracteres.',
      );
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  const d = employee;
  return (
    <Modal
      title={
        employee
          ? `Corregir empleado ${employee.nIde}-${employee.nCont}`
          : 'Nuevo empleado (alta excepcional)'
      }
      onClose={onClose}
      wide
    >
      <p className="muted">
        Es una corrección excepcional: la próxima importación de EMPLEADOS la sobrescribe. Todo
        cambio queda en el historial con su motivo.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {issues.length > 0 ? (
        <ul className="alert alert-error" aria-label="Detalle de los errores">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={onSubmit} noValidate>
        <div className="grid-2">
          {employee ? null : (
            <Field label="Identificación (N_IDE)" name="nIde" required maxLength={30} />
          )}
          {employee ? null : (
            <Field label="Contrato (N_CONT)" name="nCont" required maxLength={30} />
          )}
          <Field
            label="Empresa (C_EMP)"
            name="cEmp"
            defaultValue={d?.cEmp ?? ''}
            required
            maxLength={30}
          />
          <Field
            label="Nombre completo"
            name="nombre"
            defaultValue={d?.nombre}
            required
            maxLength={200}
          />
          <Field label="Nombres" name="nombres" defaultValue={d?.nombres ?? ''} maxLength={200} />
          <Field
            label="Apellidos"
            name="apellidos"
            defaultValue={d?.apellidos ?? ''}
            maxLength={200}
          />
          <Field
            label="Correo electrónico"
            name="email"
            type="email"
            defaultValue={d?.email}
            required
            maxLength={254}
          />
          <SelectField
            label="Estado"
            name="est"
            value={est}
            onChange={(x) => setEst(x as 'V' | 'C')}
            options={[
              { value: 'V', label: 'V - Vigente' },
              { value: 'C', label: 'C - Cancelado' },
            ]}
          />
          <Field
            label="Área (C_AREA)"
            name="cArea"
            defaultValue={d?.cArea ?? ''}
            required
            maxLength={30}
          />
          <Field
            label="Centro de costo (C_COS)"
            name="cCos"
            defaultValue={d?.cCos ?? ''}
            maxLength={30}
          />
          <Field label="Cargo (C_CAR)" name="cCar" defaultValue={d?.cCar ?? ''} maxLength={30} />
          <Field
            label="Tipo de contrato"
            name="tipoContrato"
            defaultValue={d?.tipoContrato ?? ''}
            required
            maxLength={30}
          />
          <Field
            label="Fecha de inicio"
            name="fIni"
            type="date"
            defaultValue={d?.fIni ?? ''}
            required
          />
          <Field
            label="Fecha de nacimiento"
            name="fecNac"
            type="date"
            defaultValue={d?.fecNac ?? ''}
          />
          <Field
            label="Salario actual"
            name="sAct"
            defaultValue={d?.sAct ?? ''}
            inputMode="decimal"
            hint="Solo dígitos y punto decimal."
            maxLength={20}
          />
          <Field label="HLIQ" name="hliq" defaultValue={d?.hliq ?? ''} maxLength={30} />
          <Field label="Sexo" name="sexo" defaultValue={d?.sexo ?? ''} maxLength={20} />
          <Field label="Turno" name="turno" defaultValue={d?.turno ?? ''} maxLength={30} />
          <Field label="Celular" name="celular" defaultValue={d?.celular ?? ''} maxLength={30} />
          <Field
            label="Profesión"
            name="profesion"
            defaultValue={d?.profesion ?? ''}
            maxLength={200}
          />
          <Field
            label="Nivel educativo"
            name="nivelEducativo"
            defaultValue={d?.nivelEducativo ?? ''}
            maxLength={100}
          />
        </div>
        <div className="field">
          <label htmlFor="reason">Motivo del cambio (obligatorio, mínimo 10 caracteres)</label>
          <textarea id="reason" name="reason" rows={2} required maxLength={500} />
        </div>
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StatusDialog({
  employee,
  onDone,
  onClose,
}: {
  employee: Row;
  onDone: (m: string) => void;
  onClose: () => void;
}) {
  const { call } = useAdmin();
  const target = employee.est === 'V' ? 'C' : 'V';
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    setBusy(true);
    setError(null);
    const res = await call<{ issues?: string[] }>(`/admin/employees/${employee.id}/status`, {
      method: 'POST',
      body: { est: target, version: employee.version, reason },
    });
    setBusy(false);
    if (res.status === 200)
      onDone(
        target === 'C'
          ? 'Empleado dado de baja: se cerraron sus sesiones.'
          : 'Empleado reactivado.',
      );
    else if (res.status === 422)
      setError(res.data?.issues?.join(' ') ?? 'No cumple las reglas para reactivarlo.');
    else if (res.status === 409)
      setError('Otra persona modificó este registro. Cierre y vuelva a abrirlo.');
    else if (res.status === 400) setError('Escriba un motivo de al menos 10 caracteres.');
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <Modal
      title={target === 'C' ? `Dar de baja a ${employee.nombre}` : `Reactivar a ${employee.nombre}`}
      onClose={onClose}
    >
      {target === 'C' ? (
        <p>
          Se marcará el contrato como cancelado y se cerrarán las sesiones abiertas de esta persona.
          No se borra ningún dato.
        </p>
      ) : (
        <p>Se marcará el contrato como vigente si no hay otro contrato vigente de la persona.</p>
      )}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="status-reason">Motivo (obligatorio, mínimo 10 caracteres)</label>
          <textarea id="status-reason" name="reason" rows={2} required maxLength={500} />
        </div>
        <div className="actions">
          <button type="submit" className={target === 'C' ? 'danger' : ''} disabled={busy}>
            {target === 'C' ? 'Confirmar baja' : 'Confirmar reactivación'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { call } = useAdmin();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  useEffect(() => {
    void (async () => {
      const [d, h] = await Promise.all([
        call<Detail>(`/admin/employees/${id}`),
        call<HistoryRow[]>(`/admin/employees/${id}/history`),
      ]);
      if (d.status === 200 && d.data) setDetail(d.data);
      if (h.status === 200 && h.data) setHistory(h.data);
    })();
  }, [call, id]);

  const rows: [string, string | null][] = detail
    ? [
        ['Identificación', detail.nIde],
        ['Contrato', detail.nCont],
        ['Nombre', detail.nombre],
        ['Correo', detail.email],
        ['Estado', detail.est === 'V' ? 'Vigente' : 'Cancelado'],
        ['Empresa', detail.cEmp],
        ['Área', `${detail.cArea ?? ''} ${detail.area ?? ''}`.trim()],
        ['Cargo', detail.cargo],
        ['Tipo de contrato', detail.tipoContrato],
        ['Fecha de inicio', detail.fIni],
        ['Fecha de nacimiento', detail.fecNac],
        ['Salario actual', detail.sAct],
        ['Celular', detail.celular],
        ['Origen del dato', detail.source === 'IMPORT' ? 'Importación' : 'Corrección manual'],
      ]
    : [];

  return (
    <Modal title={detail ? `Empleado ${detail.nombre}` : 'Empleado'} onClose={onClose} wide>
      {detail ? (
        <>
          <p className="muted">
            El acceso a esta ficha, que incluye el salario, queda registrado en la auditoría.
          </p>
          <dl className="stats">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v ?? '-'}</dd>
              </div>
            ))}
          </dl>
          <EmployeeAccount nIde={detail.nIde} />
          <h3>Historial de cambios</h3>
          {history.length === 0 ? (
            <p className="muted">Sin cambios manuales registrados.</p>
          ) : (
            <ul>
              {history.map((h, i) => (
                <li key={i}>
                  <strong>{ACTIONS[h.action] ?? h.action}</strong> - {formatDate(h.at)} por {h.by}.
                  Motivo: {h.reason}
                  {Object.keys(h.changes).length > 0 ? (
                    <ul>
                      {Object.entries(h.changes).map(([k, c]) => (
                        <li key={k}>
                          {FIELD_LABELS[k] ?? k}: {String(c.from ?? '-')} → {String(c.to ?? '-')}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">Cargando…</p>
      )}
    </Modal>
  );
}

export default function EmployeesPage() {
  const { call } = useAdmin();
  const [q, setQ] = useState('');
  const [est, setEst] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Detail | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [status, setStatus] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (est) params.set('est', est);
    const res = await call<Page>(`/admin/employees?${params.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call, q, est, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openEdit(id: string) {
    const res = await call<Detail>(`/admin/employees/${id}`);
    if (res.status === 200 && res.data) setEditing(res.data);
  }

  return (
    <>
      <PageHeader title="Empleados">
        <button type="button" onClick={() => setEditing('new')}>
          Nuevo empleado
        </button>
      </PageHeader>
      <p className="muted">
        Los empleados se cargan por importación desde el sistema de nómina. Aquí se consultan y se
        hacen correcciones excepcionales con motivo. No se borra a nadie: la baja marca el contrato
        como cancelado.
      </p>
      <div className="toolbar">
        <Field
          label="Buscar por nombre, identificación o correo"
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label="Estado"
          name="est"
          value={est}
          onChange={(v) => {
            setEst(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todos' },
            { value: 'V', label: 'Vigentes' },
            { value: 'C', label: 'Cancelados' },
          ]}
        />
      </div>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Empleados">
            <table>
              <caption className="muted">Empleados</caption>
              <thead>
                <tr>
                  <th scope="col">Identificación</th>
                  <th scope="col">Contrato</th>
                  <th scope="col">Nombre</th>
                  <th scope="col">Área</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Cuenta</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.nIde}</td>
                    <td>{r.nCont}</td>
                    <td>{r.nombre}</td>
                    <td>{r.area ?? r.cArea ?? '-'}</td>
                    <td>
                      {r.est === 'V' ? (
                        <Badge kind="ok">Vigente</Badge>
                      ) : (
                        <Badge kind="off">Cancelado</Badge>
                      )}
                    </td>
                    <td>{r.hasAccount ? 'Sí' : 'No'}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => setViewing(r.id)}
                          aria-label={`Ver ${r.nombre}`}
                        >
                          Ver
                        </button>
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => void openEdit(r.id)}
                          aria-label={`Corregir ${r.nombre}`}
                        >
                          Corregir
                        </button>
                        <button
                          type="button"
                          className={`small ${r.est === 'V' ? 'danger' : 'secondary'}`}
                          onClick={() => setStatus(r)}
                          aria-label={`${r.est === 'V' ? 'Dar de baja' : 'Reactivar'} ${r.nombre}`}
                        >
                          {r.est === 'V' ? 'Dar de baja' : 'Reactivar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="muted">
                      No hay empleados con esos criterios.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      ) : error ? null : (
        <p className="muted">Cargando…</p>
      )}
      {editing ? (
        <EmployeeForm
          employee={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setNotice(m);
            void load();
          }}
        />
      ) : null}
      {viewing ? <DetailDialog id={viewing} onClose={() => setViewing(null)} /> : null}
      {status ? (
        <StatusDialog
          employee={status}
          onClose={() => setStatus(null)}
          onDone={(m) => {
            setStatus(null);
            setNotice(m);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
