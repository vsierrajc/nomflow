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

type Kind = 'AREA' | 'CCOSTO' | 'CARGO' | 'TIPO_CONTRATO';

const KINDS: { kind: Kind; label: string; singular: string; global: boolean }[] = [
  { kind: 'AREA', label: 'Áreas', singular: 'área', global: false },
  { kind: 'CCOSTO', label: 'Centros de costo', singular: 'centro de costo', global: false },
  { kind: 'CARGO', label: 'Cargos', singular: 'cargo', global: false },
  { kind: 'TIPO_CONTRATO', label: 'Tipos de contrato', singular: 'tipo de contrato', global: true },
];

interface Company {
  cEmp: string;
  nombre: string;
  active: boolean;
}

interface Entry {
  id: string;
  code: string;
  name: string;
  active: boolean;
  version: number;
  updatedAt: string;
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Entry[];
}

interface HistoryRow {
  oldName: string;
  newName: string;
  changedAt: string;
}

const PAGE_SIZE = 25;

function EntryForm({
  kind,
  singular,
  cEmp,
  entry,
  onDone,
  onClose,
}: {
  kind: Kind;
  singular: string;
  cEmp: string;
  entry: Entry | null;
  onDone: (m: string) => void;
  onClose: () => void;
}) {
  const { call } = useAdmin();
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(entry?.active ?? true);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '');
    setBusy(true);
    setError(null);
    const res = entry
      ? await call<{ code?: string; usage?: Record<string, number> }>(
          `/admin/catalogs/${kind}/${entry.id}`,
          { method: 'PUT', body: { name, active, version: entry.version } },
        )
      : await call<{ code?: string }>(`/admin/catalogs/${kind}`, {
          method: 'POST',
          body: { cEmp: cEmp || undefined, code: String(f.get('code') ?? ''), name },
        });
    setBusy(false);
    if (res.status === 200 || res.status === 201)
      onDone(entry ? 'Registro actualizado.' : 'Registro creado.');
    else if (res.status === 409) {
      const d = res.data as { code?: string; usage?: Record<string, number> } | null;
      if (d?.code === 'IN_USE') {
        const parts = Object.entries(d.usage ?? {})
          .filter(([, n]) => n > 0)
          .map(
            ([k, n]) =>
              `${n} ${k === 'managers' ? 'jefe(s) asignado(s)' : 'empleado(s) vigente(s)'}`,
          );
        setError(`No se puede desactivar: está en uso por ${parts.join(' y ')}.`);
      } else if (d?.code === 'VERSION_CONFLICT')
        setError('Otra persona modificó este registro. Cierre y vuelva a abrirlo.');
      else setError('Ya existe un registro con ese código.');
    } else if (res.status === 422) setError('Debe elegir una empresa existente.');
    else if (res.status === 400)
      setError('Revise los datos: el código y el nombre son obligatorios.');
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <Modal
      title={entry ? `Editar ${singular} ${entry.code}` : `Nuevo ${singular}`}
      onClose={onClose}
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form onSubmit={onSubmit} noValidate>
        {entry ? null : (
          <Field
            label="Código"
            name="code"
            required
            maxLength={30}
            hint="Se conserva tal cual, incluidos los ceros iniciales."
          />
        )}
        <Field label="Nombre" name="name" defaultValue={entry?.name} required maxLength={200} />
        {entry ? (
          <label className="choice">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
            Activo
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

export default function CatalogsPage() {
  const { call, profile } = useAdmin();
  const [kind, setKind] = useState<Kind>('AREA');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [cEmp, setCEmp] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  const [history, setHistory] = useState<{ entry: Entry; rows: HistoryRow[] } | null>(null);

  const meta = KINDS.find((k) => k.kind === kind) ?? KINDS[0]!;

  useEffect(() => {
    void (async () => {
      const res = await call<Company[]>('/admin/companies');
      if (res.status === 200 && res.data) {
        const list = res.data.filter((c) => c.active);
        setCompanies(list);
        setCEmp((prev) => prev || list[0]?.cEmp || '');
      }
    })();
  }, [call]);

  const load = useCallback(async () => {
    if (!meta.global && !cEmp) {
      setData(null);
      return;
    }
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (!meta.global) params.set('cEmp', cEmp);
    if (q) params.set('q', q);
    if (active) params.set('active', active);
    const res = await call<Page>(`/admin/catalogs/${kind}?${params.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call, kind, cEmp, q, active, page, meta.global]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openHistory(entry: Entry) {
    const res = await call<HistoryRow[]>(`/admin/catalogs/${kind}/${entry.id}/history`);
    if (res.status === 200 && res.data) setHistory({ entry, rows: res.data });
  }

  return (
    <>
      <PageHeader title="Áreas, cargos, centros de costo y tipos de contrato">
        <button type="button" onClick={() => setEditing('new')} disabled={!meta.global && !cEmp}>
          Nuevo {meta.singular}
        </button>
      </PageHeader>
      <div role="tablist" aria-label="Catálogo" className="toolbar">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="tab"
            aria-selected={k.kind === kind}
            className={k.kind === kind ? '' : 'secondary'}
            onClick={() => {
              setKind(k.kind);
              setPage(1);
              setNotice(null);
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        {meta.global ? null : (
          <SelectField
            label="Empresa"
            name="cEmp"
            value={cEmp}
            onChange={(v) => {
              setCEmp(v);
              setPage(1);
            }}
            options={
              companies.length
                ? companies.map((c) => ({ value: c.cEmp, label: `${c.cEmp} - ${c.nombre}` }))
                : [{ value: '', label: 'Cree primero una empresa' }]
            }
          />
        )}
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
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabla de datos">
            <table>
              <caption className="muted">{meta.label}</caption>
              <thead>
                <tr>
                  <th scope="col">Código</th>
                  <th scope="col">Nombre</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Actualizado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.code}</td>
                    <td>{e.name}</td>
                    <td>
                      {e.active ? (
                        <Badge kind="ok">Activo</Badge>
                      ) : (
                        <Badge kind="off">Inactivo</Badge>
                      )}
                    </td>
                    <td>{formatDate(e.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => setEditing(e)}
                          aria-label={`Editar ${e.code}`}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => void openHistory(e)}
                          aria-label={`Historial de ${e.code}`}
                        >
                          Historial
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No hay registros. Cree uno o importe el archivo Excel.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      ) : error ? null : (
        <p className="muted">
          {!meta.global && !cEmp ? 'Cree o elija una empresa para ver este catálogo.' : 'Cargando…'}
        </p>
      )}

      <ImportPanel
        key={`${kind}-${cEmp}`}
        title={`Importar ${meta.label.toLowerCase()} desde Excel`}
        endpoint={`/admin/imports/catalogs/${kind}`}
        defaultResponsible={profile.email}
        extraFields={
          meta.global
            ? []
            : [
                {
                  name: 'cEmp',
                  label: 'Empresa a la que pertenece el catálogo',
                  required: true,
                  defaultValue: cEmp,
                  maxLength: 30,
                },
              ]
        }
        onApplied={() => void load()}
      >
        <p className="muted">
          {kind === 'AREA' ? 'Columnas: C_ARE, NOMAREA (JEFE_AREA se ignora).' : null}
          {kind === 'CCOSTO' ? 'Columnas: C_COS, CCOSTO.' : null}
          {kind === 'CARGO' ? 'Columnas: C_CAR, CARGO.' : null}
          {kind === 'TIPO_CONTRATO' ? 'Columnas: TIPO_CONTRATO, NOMCONTRATO.' : null} Un código
          repetido con nombres distintos detiene la carga.
        </p>
      </ImportPanel>

      {editing ? (
        <EntryForm
          kind={kind}
          singular={meta.singular}
          cEmp={meta.global ? '' : cEmp}
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setNotice(m);
            void load();
          }}
        />
      ) : null}
      {history ? (
        <Modal title={`Historial de ${history.entry.code}`} onClose={() => setHistory(null)}>
          {history.rows.length === 0 ? (
            <p className="muted">Este registro no ha cambiado de nombre.</p>
          ) : (
            <ul>
              {history.rows.map((h, i) => (
                <li key={i}>
                  {formatDate(h.changedAt)}: «{h.oldName}» pasó a «{h.newName}»
                </li>
              ))}
            </ul>
          )}
        </Modal>
      ) : null}
    </>
  );
}
