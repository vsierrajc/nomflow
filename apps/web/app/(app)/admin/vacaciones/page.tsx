'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, Pager, PageHeader, SelectField } from '@/components/admin-ui';
import { IconButton } from '@/components/icon-button';
import { ImportPanel } from '@/components/import-panel';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

type Estado = 'ACTIVA' | 'LIQUIDADA' | 'VENCIDA';

interface Period {
  id: string;
  nIde: string;
  nombre: string | null;
  nCont: string;
  perIni: string;
  perFin: string;
  dias: number;
  disp: number;
  estado: Estado;
  estOrigen: string | null;
  version: number;
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Period[];
}

interface EmployeeOption {
  nIde: string;
  nCont: string;
  nombre: string | null;
}

const PAGE_SIZE = 25;
const ESTADOS: { value: Estado | ''; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'ACTIVA', label: 'Activa' },
  { value: 'VENCIDA', label: 'Vencida' },
  { value: 'LIQUIDADA', label: 'Liquidada' },
];

function label(e: { nIde: string; nombre: string | null }): string {
  return `${e.nIde} - ${e.nombre ?? 'Sin nombre'}`;
}

export default function VacationPeriodsPage() {
  const { call, profile } = useAdmin();
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [companies, setCompanies] = useState<string[]>([]);
  const [cEmp, setCEmp] = useState('');
  const [estado, setEstado] = useState<Estado | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Period | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[] | null>(null);
  const [selected, setSelected] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (q) params.set('q', q);
    if (estado) params.set('estado', estado);
    if (cEmp) params.set('cEmp', cEmp);
    const res = await call<Page>(`/admin/prog-vac?${params.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call, page, q, estado, cEmp]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await call<string[]>('/admin/prog-vac/companies');
      if (res.status === 200 && res.data) setCompanies(res.data);
    })();
  }, [call]);

  // Lista de valores: todos los empleados activos.
  useEffect(() => {
    void (async () => {
      const res = await call<EmployeeOption[]>('/admin/prog-vac/employees');
      if (res.status === 200 && res.data) setEmployees(res.data);
    })();
  }, [call]);

  const chosen = employees?.find((e) => label(e) === selected.trim()) ?? null;

  function fail(status: number) {
    if (status === 400)
      setError(
        'Revise los datos: 0 ≤ disponibles ≤ días ≤ 15, fechas coherentes, motivo de al menos 10 caracteres y un empleado existente.',
      );
    else if (status === 409) setError('Ese período ya existe para el contrato.');
    else if (status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    if (!chosen) return setError('Elija el empleado de la lista.');
    const res = await call('/admin/prog-vac', {
      method: 'POST',
      body: {
        nIde: chosen.nIde,
        nCont: chosen.nCont,
        perIni: String(f.get('perIni') ?? ''),
        perFin: String(f.get('perFin') ?? ''),
        dias: Number(f.get('dias')),
        disp: Number(f.get('disp')),
      },
    });
    if (res.status === 201) {
      setOk('Período creado.');
      form.reset();
      setSelected('');
      setPage(1);
      await load();
    } else fail(res.status);
  }

  async function adjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call(`/admin/prog-vac/${editing.id}`, {
      method: 'PUT',
      body: {
        dias: Number(f.get('dias')),
        disp: Number(f.get('disp')),
        reason: String(f.get('reason') ?? ''),
      },
    });
    if (res.status === 200) {
      setOk('Ajuste registrado con su motivo; el período subió de versión.');
      setEditing(null);
      await load();
    } else fail(res.status);
  }

  async function remove(p: Period) {
    setError(null);
    setOk(null);
    const res = await call(`/admin/prog-vac/${p.id}`, { method: 'DELETE' });
    if (res.status === 204 || res.status === 200) {
      setOk('Período dado de baja.');
      await load();
    } else fail(res.status);
  }

  return (
    <>
      <PageHeader title="Períodos de vacaciones" />
      <p className="muted">
        Días hábiles programados (<code>DIAS</code>) y disponibles (<code>DISP</code>) por contrato.
        Un período con 0 disponibles queda «Liquidada» (se disfrutó) o «Vencida» (se causó un ciclo
        nuevo sin haberlo tomado) y no se ofrece para nuevas solicitudes. Toda corrección exige
        motivo y queda versionada.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      <ImportPanel
        title="Importar períodos desde Excel (PROG_VAC)"
        endpoint="/admin/imports/prog-vac"
        defaultResponsible={profile.email}
        extraFields={[
          {
            name: 'fechaCorte',
            label: 'Fecha de corte (AAAA-MM-DD)',
            hint: 'Fecha a la que corresponden los días disponibles del archivo.',
            pattern: '\\d{4}-\\d{2}-\\d{2}',
            maxLength: 10,
          },
        ]}
        onApplied={() => void load()}
      >
        <p className="muted">
          Columnas: N_IDE, N_CONT, PER_INI, PER_FIN, DIAS, DISP y EST. Las fechas van como
          DD/MM/AAAA. Se exige 0 ≤ DISP ≤ DIAS ≤ 15 y que el empleado ya esté importado. Si el
          período ya existe, la carga corrige sus días y deja el ajuste versionado con la fecha de
          corte; revise la vista previa (nuevos, modificados y sin cambios) antes de aplicar. Guarde
          N_IDE y N_CONT como texto para no perder ceros iniciales.
        </p>
      </ImportPanel>

      <section className="import-panel" aria-label="Nuevo período">
        <h2>Nuevo período</h2>
        <form onSubmit={create} noValidate>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="prog-vac-empleado">Identificación</label>
              <input
                id="prog-vac-empleado"
                list="prog-vac-empleados"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                placeholder={
                  employees === null
                    ? 'Cargando…'
                    : 'Escriba el nombre o la cédula y elija de la lista'
                }
                autoComplete="off"
                required
              />
              <datalist id="prog-vac-empleados">
                {employees?.map((e) => (
                  <option key={e.nIde} value={label(e)} />
                ))}
              </datalist>
            </div>
            <Field
              label="Contrato (N_CONT)"
              name="nCont"
              value={chosen?.nCont ?? ''}
              readOnly
              hint="Se completa con el contrato vigente del empleado elegido."
            />
            <Field label="Inicio del período" name="perIni" type="date" required />
            <Field label="Fin del período" name="perFin" type="date" required />
            <Field label="Días hábiles programados (máx. 15)" name="dias" type="number" required />
            <Field label="Días hábiles disponibles" name="disp" type="number" required />
          </div>
          <button type="submit">Crear período</button>
        </form>
      </section>

      {editing ? (
        <section className="import-panel" aria-label="Ajustar período">
          <h2>
            Ajustar período {editing.perIni} a {editing.perFin} (empleado{' '}
            {editing.nombre ?? editing.nIde})
          </h2>
          <form onSubmit={adjust} noValidate>
            <div className="grid-2">
              <Field
                label="Días programados"
                name="dias"
                type="number"
                defaultValue={editing.dias}
                required
              />
              <Field
                label="Días disponibles"
                name="disp"
                type="number"
                defaultValue={editing.disp}
                required
              />
            </div>
            <Field label="Motivo (mínimo 10 caracteres)" name="reason" required maxLength={300} />
            <button type="submit">Guardar ajuste</button>{' '}
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </form>
        </section>
      ) : null}

      <h2>Períodos registrados</h2>
      <div role="tablist" aria-label="Filtrar por estado" className="segmented">
        {ESTADOS.map((e) => (
          <button
            key={e.value || 'todos'}
            type="button"
            role="tab"
            aria-selected={estado === e.value}
            className={estado === e.value ? 'active' : ''}
            onClick={() => {
              setEstado(e.value);
              setPage(1);
            }}
          >
            {e.label}
          </button>
        ))}
      </div>
      <form
        className="toolbar"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const v = String(new FormData(e.currentTarget).get('q') ?? '').trim();
          setQ(v);
          setPage(1);
        }}
      >
        <Field
          label="Buscar por nombre o identificación"
          name="q"
          defaultValue={q}
          maxLength={100}
        />
        {companies.length > 1 ? (
          <SelectField
            label="Empresa"
            name="cEmp"
            value={cEmp}
            onChange={(v) => {
              setCEmp(v);
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todas' },
              ...companies.map((c) => ({ value: c, label: c })),
            ]}
          />
        ) : null}
        <button type="submit" className="secondary">
          Buscar
        </button>
      </form>

      {data === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Períodos de vacaciones"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Empleado</th>
                  <th scope="col">Contrato</th>
                  <th scope="col">Período</th>
                  <th scope="col">Días</th>
                  <th scope="col">Disponibles</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Versión</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.nombre ?? 'Sin nombre'}</strong>
                      <span className="muted"> - {p.nIde}</span>
                    </td>
                    <td>{p.nCont}</td>
                    <td>
                      {p.perIni} a {p.perFin}
                    </td>
                    <td className="num">{p.dias}</td>
                    <td className="num">{p.disp}</td>
                    <td>
                      <Badge
                        kind={
                          p.estado === 'ACTIVA' ? 'ok' : p.estado === 'VENCIDA' ? 'warn' : 'off'
                        }
                      >
                        {p.estado === 'ACTIVA'
                          ? 'Activa'
                          : p.estado === 'VENCIDA'
                            ? 'Vencida'
                            : 'Liquidada'}
                      </Badge>
                    </td>
                    <td className="num">{p.version}</td>
                    <td>
                      <div className="row-actions">
                        <IconButton
                          icon="edit"
                          label={`Ajustar período ${p.perIni} a ${p.perFin} de ${p.nombre ?? p.nIde}`}
                          onClick={() => setEditing(p)}
                        />
                        <IconButton
                          icon="delete"
                          variant="danger"
                          label={`Dar de baja período ${p.perIni} a ${p.perFin} de ${p.nombre ?? p.nIde}`}
                          onClick={() => void remove(p)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="muted">
                      No hay períodos que coincidan con el filtro.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
