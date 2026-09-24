'use client';

import { useCallback, useEffect, useState } from 'react';
import { ImportPanel } from '@/components/import-panel';
import { Badge, Notice, PageHeader, Pager, SelectField, formatDate } from '@/components/admin-ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Item {
  id: string;
  type: string;
  status: string;
  rowCount: number;
  errorCount: number;
  fileName: string | null;
  createdAt: string;
  appliedAt: string | null;
  createdBy: string;
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Item[];
}

const TYPES: Record<string, string> = {
  EMPLEADOS: 'Empleados',
  NOMINA: 'Nómina',
  CONCEPTO: 'Conceptos',
  PROG_VAC: 'Períodos de vacaciones',
  AREA: 'Áreas',
  CCOSTO: 'Centros de costo',
  CARGO: 'Cargos',
  TIPO_CONTRATO: 'Tipos de contrato',
};
const STATUS_KIND: Record<string, 'ok' | 'warn' | 'off'> = {
  APLICADO: 'ok',
  LISTO: 'warn',
  OBSERVADO: 'warn',
  FALLIDO: 'off',
  APLICANDO: 'warn',
};
const PAGE_SIZE = 20;

type Tab = 'EMPLEADOS' | 'NOMINA';

export default function ImportsPage() {
  const { call, profile } = useAdmin();
  const [tab, setTab] = useState<Tab>('EMPLEADOS');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    const res = await call<Page>(`/admin/imports?${params.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call, type, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="Importaciones" />
      <p className="muted">
        Cada carga se valida primero y no cambia nada hasta que usted la aplica. Los catálogos y los
        conceptos se importan desde sus propias pantallas.
      </p>
      <div role="tablist" aria-label="Tipo de importación" className="toolbar">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'EMPLEADOS'}
          className={tab === 'EMPLEADOS' ? '' : 'secondary'}
          onClick={() => setTab('EMPLEADOS')}
        >
          Empleados
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'NOMINA'}
          className={tab === 'NOMINA' ? '' : 'secondary'}
          onClick={() => setTab('NOMINA')}
        >
          Nómina
        </button>
      </div>

      {tab === 'EMPLEADOS' ? (
        <ImportPanel
          key="emp"
          title="Importar empleados desde Excel"
          endpoint="/admin/imports/employees"
          defaultResponsible={profile.email}
          onApplied={() => void load()}
        >
          <p className="muted">
            Archivo con las 24 columnas de EMPLEADOS. Solo se aceptan los estados V (vigente) y C
            (cancelado); las empresas y los catálogos deben estar publicados antes.
          </p>
        </ImportPanel>
      ) : (
        <ImportPanel
          key="nom"
          title="Importar una liquidación de nómina desde Excel"
          endpoint="/admin/imports/payroll"
          defaultResponsible={profile.email}
          extraFields={[
            {
              name: 'per',
              label: 'Período (AAAAMM)',
              required: true,
              pattern: '\\d{6}',
              maxLength: 6,
              hint: 'Por ejemplo 202609.',
            },
            {
              name: 'nLiq',
              label: 'Liquidación (1 o 2)',
              required: true,
              pattern: '[12]',
              maxLength: 1,
            },
          ]}
          onApplied={() => void load()}
        >
          <p className="muted">
            El archivo debe traer <strong>todas</strong> las filas de esa liquidación. Se compara el
            conteo y las sumas de devengado y deducido antes de publicar; una corrección crea una
            versión nueva y conserva la anterior.
          </p>
        </ImportPanel>
      )}

      <h2 style={{ marginTop: 28 }}>Historial de importaciones</h2>
      <div className="toolbar">
        <SelectField
          label="Tipo"
          name="type"
          value={type}
          onChange={(v) => {
            setType(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todos' },
            ...Object.entries(TYPES).map(([value, label]) => ({ value, label })),
          ]}
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
            { value: 'APLICADO', label: 'Aplicadas' },
            { value: 'LISTO', label: 'Listas para aplicar' },
            { value: 'OBSERVADO', label: 'Con observaciones' },
            { value: 'FALLIDO', label: 'Fallidas' },
          ]}
        />
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Historial de importaciones"
          >
            <table>
              <caption className="muted">Historial de importaciones</caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Archivo</th>
                  <th scope="col">Filas</th>
                  <th scope="col">Errores</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Cargó</th>
                  <th scope="col">Aplicada</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id}>
                    <td>{formatDate(i.createdAt)}</td>
                    <td>{TYPES[i.type] ?? i.type}</td>
                    <td>{i.fileName ?? '-'}</td>
                    <td className="num">{i.rowCount}</td>
                    <td className="num">{i.errorCount}</td>
                    <td>
                      <Badge kind={STATUS_KIND[i.status] ?? 'warn'}>{i.status}</Badge>
                    </td>
                    <td>{i.createdBy}</td>
                    <td>{i.appliedAt ? formatDate(i.appliedAt) : '-'}</td>
                  </tr>
                ))}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="muted">
                      Todavía no hay importaciones.
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
    </>
  );
}
