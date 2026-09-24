'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ImportPanel } from '../../../components/import-panel';
import {
  Badge,
  Modal,
  Notice,
  PageHeader,
  Pager,
  SelectField,
  formatDate,
} from '../../../components/admin-ui';
import { Field } from '../../../components/ui';
import { NETWORK_ERROR } from '../../../lib/api';
import { useAdmin } from '../../../lib/admin';

interface Concept {
  id: string;
  code: string;
  name: string;
  unit: string;
  active: boolean;
  version: number;
  updatedAt: string;
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Concept[];
}

interface Unit {
  code: string;
  label: string;
}

const PAGE_SIZE = 25;

function ConceptForm({
  concept,
  units,
  onDone,
  onClose,
}: {
  concept: Concept | null;
  units: Unit[];
  onDone: (m: string) => void;
  onClose: () => void;
}) {
  const { call } = useAdmin();
  const [unit, setUnit] = useState(concept?.unit ?? units[0]?.code ?? 'PES');
  const [active, setActive] = useState(concept?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '');
    setBusy(true);
    setError(null);
    const res = concept
      ? await call<{ code?: string }>(`/admin/payroll-concepts/${concept.id}`, {
          method: 'PUT',
          body: { name, unit, active, version: concept.version },
        })
      : await call<{ code?: string }>('/admin/payroll-concepts', {
          method: 'POST',
          body: { code: String(f.get('code') ?? ''), name, unit },
        });
    setBusy(false);
    if (res.status === 200 || res.status === 201)
      onDone(concept ? 'Concepto actualizado.' : 'Concepto creado.');
    else if (res.status === 409)
      setError(
        res.data?.code === 'VERSION_CONFLICT'
          ? 'Otra persona modificó este concepto. Cierre y vuelva a abrirlo.'
          : 'Ya existe un concepto con ese código.',
      );
    else if (res.status === 400)
      setError('Revise los datos: código, nombre y unidad son obligatorios.');
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <Modal
      title={concept ? `Editar concepto ${concept.code}` : 'Nuevo concepto de nómina'}
      onClose={onClose}
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form onSubmit={onSubmit} noValidate>
        {concept ? null : (
          <Field
            label="Código del concepto"
            name="code"
            required
            maxLength={30}
            hint="Se conserva tal cual, incluidos los ceros iniciales."
          />
        )}
        <Field
          label="Descripción"
          name="name"
          defaultValue={concept?.name}
          required
          maxLength={200}
        />
        <SelectField
          label="Unidad de la cantidad"
          name="unit"
          value={unit}
          onChange={setUnit}
          options={units.map((u) => ({ value: u.code, label: `${u.code} - ${u.label}` }))}
        />
        {concept ? (
          <label className="choice">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
            Concepto activo
          </label>
        ) : null}
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

export default function ConceptsPage() {
  const { call, profile } = useAdmin();
  const [units, setUnits] = useState<Unit[]>([]);
  const [q, setQ] = useState('');
  const [unit, setUnit] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Concept | 'new' | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await call<Unit[]>('/admin/payroll-concepts/units');
      if (res.status === 200 && res.data) setUnits(res.data.filter((u) => u.code !== 'DIAS'));
    })();
  }, [call]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (unit) params.set('unit', unit);
    if (active) params.set('active', active);
    const res = await call<Page>(`/admin/payroll-concepts?${params.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call, q, unit, active, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="Conceptos de nómina">
        <button type="button" onClick={() => setEditing('new')}>
          Nuevo concepto
        </button>
      </PageHeader>
      <p className="muted">
        La unidad indica cómo se lee la cantidad de cada concepto en el volante (por ejemplo, horas
        o pesos). Los conceptos que no estén aquí se muestran sin unidad.
      </p>
      <div className="toolbar">
        <Field
          label="Buscar"
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label="Unidad"
          name="unit"
          value={unit}
          onChange={(v) => {
            setUnit(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todas' },
            ...units.map((u) => ({ value: u.code, label: `${u.code} - ${u.label}` })),
          ]}
        />
        <SelectField
          label="Estado"
          name="active"
          value={active}
          onChange={(v) => {
            setActive(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todos' },
            { value: 'true', label: 'Activos' },
            { value: 'false', label: 'Inactivos' },
          ]}
        />
      </div>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Conceptos de nómina">
            <table>
              <caption className="muted">Conceptos de nómina</caption>
              <thead>
                <tr>
                  <th scope="col">Código</th>
                  <th scope="col">Descripción</th>
                  <th scope="col">Unidad</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Actualizado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>{c.code}</td>
                    <td>{c.name}</td>
                    <td>{c.unit}</td>
                    <td>
                      {c.active ? (
                        <Badge kind="ok">Activo</Badge>
                      ) : (
                        <Badge kind="off">Inactivo</Badge>
                      )}
                    </td>
                    <td>{formatDate(c.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => setEditing(c)}
                        aria-label={`Editar concepto ${c.code}`}
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No hay conceptos. Cree uno o importe el archivo Excel de conceptos.
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

      <ImportPanel
        title="Importar conceptos desde Excel"
        endpoint="/admin/imports/concepts"
        defaultResponsible={profile.email}
        onApplied={() => void load()}
      >
        <p className="muted">
          Columnas: CONCEPTO, NOMCONCEPTO, UNIDAD. Los códigos deben ser texto para conservar los
          ceros iniciales.
        </p>
      </ImportPanel>

      {editing ? (
        <ConceptForm
          concept={editing === 'new' ? null : editing}
          units={units}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setNotice(m);
            void load();
          }}
        />
      ) : null}
    </>
  );
}
