'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, Pager, SelectField, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Item {
  id: string;
  at: string;
  action: string;
  resource: string;
  resourceId: string | null;
  result: string;
  actor: string | null;
  context: {
    method?: string;
    durationMs?: number;
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string;
  };
}

interface Result {
  total: number;
  page: number;
  pageSize: number;
  items: Item[];
}

const PAGE_SIZE = 50;

function statusKind(result: string): 'ok' | 'warn' | 'off' {
  if (/^2\d\d$/.test(result) || result === 'SUCCESS') return 'ok';
  if (/^[45]\d\d$/.test(result)) return /^5/.test(result) ? 'off' : 'warn';
  return 'off';
}

export default function AuditPage() {
  const { call } = useAdmin();
  const [filters, setFilters] = useState({
    kind: '',
    actor: '',
    method: '',
    status: '',
    route: '',
    action: '',
    from: '',
    to: '',
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (f: typeof filters, p: number) => {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
      const res = await call<Result>(`/admin/audit?${params.toString()}`);
      if (res.status === 200 && res.data) {
        setData(res.data);
        setError(null);
      } else if (res.status === 400) setError('Revise los filtros: alguno no es válido.');
      else setError(NETWORK_ERROR);
    },
    [call],
  );

  useEffect(() => {
    void load(filters, page);
  }, [load, filters, page]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const next = Object.fromEntries(
      Object.keys(filters).map((k) => [k, String(form.get(k) ?? '')]),
    ) as typeof filters;
    setPage(1);
    setFilters(next);
  }

  return (
    <>
      <PageHeader title="Auditoría de peticiones y actividades" />
      <p className="muted">
        Historial de todas las peticiones de todos los usuarios y de las actividades del sistema. No
        se guardan cuerpos, claves, códigos ni identificaciones.
      </p>
      <form onSubmit={onSubmit} className="toolbar" aria-label="Filtros de auditoría">
        <SelectField
          label="Tipo"
          name="kind"
          value={filters.kind}
          onChange={(v) => setFilters({ ...filters, kind: v })}
          options={[
            { value: '', label: 'Todos' },
            { value: 'HTTP', label: 'Peticiones' },
            { value: 'EVENT', label: 'Actividades' },
          ]}
        />
        <Field label="Usuario (correo)" name="actor" defaultValue={filters.actor} />
        <Field label="Ruta" name="route" defaultValue={filters.route} />
        <Field
          label="Método"
          name="method"
          defaultValue={filters.method}
          placeholder="GET, POST…"
        />
        <Field label="Estado" name="status" defaultValue={filters.status} placeholder="403" />
        <Field label="Actividad" name="action" defaultValue={filters.action} placeholder="LOGIN" />
        <Field label="Desde" name="from" type="date" defaultValue={filters.from} />
        <Field label="Hasta" name="to" type="date" defaultValue={filters.to} />
        <button type="submit">Filtrar</button>
      </form>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Registro de auditoría">
            <table>
              <caption className="muted">Registro de auditoría</caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Usuario</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Actividad o ruta</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => {
                  const http = i.action === 'HTTP_REQUEST';
                  return (
                    <tr key={i.id}>
                      <td>{formatDate(i.at)}</td>
                      <td>{i.actor ?? '(sin sesión)'}</td>
                      <td>{http ? 'Petición' : 'Actividad'}</td>
                      <td>
                        {http
                          ? `${i.context.method ?? ''} ${i.resource}`
                          : `${i.action}${i.resource ? ` - ${i.resource}` : ''}`}
                      </td>
                      <td>
                        <Badge kind={statusKind(i.result)}>{i.result}</Badge>
                      </td>
                      <td className="muted">
                        {http
                          ? `${i.context.durationMs ?? '?'} ms - ${i.context.ip ?? ''}`
                          : (i.resourceId ?? '')}
                      </td>
                    </tr>
                  );
                })}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No hay registros con esos filtros.
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
