'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Notice, PageHeader, Pager, SelectField, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Row {
  id: string;
  createdAt: string;
  nIde: string;
  nombre: string | null;
  kind: 'GENERAL' | 'DIRIGIDO';
  addressee: string | null;
  docCode: string;
  docVersion: string;
  templateVersion: number;
  signerName: string | null;
  signerTitle: string | null;
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Row[];
}

export default function IssuedCertificatesPage() {
  const { call, download } = useAdmin();
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q) qs.set('q', q);
    if (kind) qs.set('kind', kind);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const res = await call<Page>(`/admin/labor-certificates/history?${qs.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(res.status === 400 ? 'Revise los filtros.' : NETWORK_ERROR);
  }, [call, page, q, kind, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function filter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setQ(String(f.get('q') ?? '').trim());
    setFrom(String(f.get('from') ?? ''));
    setTo(String(f.get('to') ?? ''));
    setPage(1);
  }

  async function open(row: Row) {
    setError(null);
    const res = await download(`/admin/labor-certificates/history/${row.id}/pdf`);
    if (res.status === 200 && res.blob) {
      const url = URL.createObjectURL(res.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError('No se pudo abrir el certificado.');
  }

  return (
    <>
      <PageHeader title="Certificados laborales emitidos" />
      <p className="muted">
        Historial de todas las solicitudes de certificado laboral de los empleados. Cada consulta o
        descarga queda en la auditoría.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form className="filters" onSubmit={filter} noValidate>
        <Field
          label="Buscar por nombre, identificación o destinatario"
          name="q"
          defaultValue={q}
          maxLength={100}
        />
        <SelectField
          label="Tipo"
          name="kind"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todos' },
            { value: 'GENERAL', label: 'General' },
            { value: 'DIRIGIDO', label: 'Dirigido' },
          ]}
        />
        <Field label="Desde" name="from" type="date" defaultValue={from} />
        <Field label="Hasta" name="to" type="date" defaultValue={to} />
        <button type="submit">Filtrar</button>
      </form>

      {data === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : data.items.length === 0 ? (
        <p className="muted">No hay solicitudes con esos filtros.</p>
      ) : (
        <>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Historial de certificados laborales"
          >
            <table>
              <caption className="muted">{data.total} solicitudes</caption>
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Empleado</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Dirigido a</th>
                  <th scope="col">Formato</th>
                  <th scope="col">Firmó</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDate(r.createdAt)}</td>
                    <td>
                      {r.nombre ?? r.nIde} <span className="muted">({r.nIde})</span>
                    </td>
                    <td>{r.kind === 'GENERAL' ? 'General' : 'Dirigido'}</td>
                    <td>{r.addressee ?? '-'}</td>
                    <td>
                      {r.docCode} v{r.docVersion} (plantilla {r.templateVersion})
                    </td>
                    <td>
                      {r.signerName ?? '-'}
                      {r.signerTitle ? <span className="muted"> ({r.signerTitle})</span> : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => void open(r)}
                        aria-label={`Abrir el certificado de ${r.nombre ?? r.nIde} del ${formatDate(r.createdAt)}`}
                      >
                        Abrir PDF
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </>
  );
}
