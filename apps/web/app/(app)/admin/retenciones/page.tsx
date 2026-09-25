'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Item {
  id: string;
  nIde: string;
  year: number;
  version: number;
  active: boolean;
  sizeBytes: number;
  uploadedAt: string;
}
interface Outcome {
  file: string;
  result: string;
}

const RESULTS: Record<string, string> = {
  CARGADO: 'Cargado',
  SIN_CAMBIOS: 'Sin cambios (mismo contenido)',
  NOMBRE_INVALIDO: 'Nombre inválido (use identificación_año.pdf)',
  ANIO_INVALIDO: 'Año inválido',
  EMPLEADO_NO_EXISTE: 'No existe un empleado con esa identificación',
  NO_ES_PDF: 'No es un PDF válido',
  DEMASIADO_GRANDE: 'Supera el tamaño máximo',
  ALMACENAMIENTO_NO_DISPONIBLE:
    'El almacén de documentos no respondió: el archivo sigue en la carpeta y se reintenta en el próximo proceso',
  ERROR: 'Error: se reintentará en el próximo proceso',
};

export default function TaxCertificatesAdminPage() {
  const { call } = useAdmin();
  const [items, setItems] = useState<Item[] | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(
    async (nIde = '') => {
      const res = await call<Item[]>(
        `/admin/tax-certificates${nIde ? `?nIde=${encodeURIComponent(nIde)}` : ''}`,
      );
      if (res.status === 200 && res.data) setItems(res.data);
      else setError(NETWORK_ERROR);
    },
    [call],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    const res = await call<{ results: Outcome[] }>('/admin/tax-certificates/process', {
      method: 'POST',
    });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setOutcomes(res.data.results);
      await load(filter);
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get('nIde') ?? '').trim();
    setFilter(v);
    void load(v);
  }

  return (
    <>
      <PageHeader title="Certificados de retención" />
      <section className="import-panel" aria-label="Procesar carpeta">
        <h2>Carga masiva desde la carpeta de procesamiento</h2>
        <p className="muted">
          Deposite en la carpeta del servidor (variable <code>TAX_CERT_INBOX_DIR</code>) los PDF
          nombrados <code>identificación_año.pdf</code>, por ejemplo <code>840695_2025.pdf</code>, y
          pulse «Procesar». Los válidos pasan a <code>procesados/</code> y los demás a{' '}
          <code>rechazados/</code>. Un archivo con distinto contenido crea una versión nueva y
          reemplaza la vigente.
        </p>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <button type="button" onClick={() => void run()} disabled={busy}>
          {busy ? 'Procesando…' : 'Procesar carpeta'}
        </button>
        {outcomes ? (
          outcomes.length === 0 ? (
            <Notice kind="ok">La carpeta no tenía archivos por procesar.</Notice>
          ) : (
            <ul aria-label="Resultado del proceso">
              {outcomes.map((o) => (
                <li key={o.file}>
                  <code>{o.file}</code>: {RESULTS[o.result] ?? o.result}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      <form onSubmit={search} className="toolbar" noValidate>
        <Field label="Filtrar por identificación" name="nIde" maxLength={30} />
        <button type="submit" className="secondary">
          Filtrar
        </button>
      </form>
      {items === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Certificados cargados (hasta 500 recientes)"
        >
          <table>
            <caption className="muted">Certificados cargados (hasta 500 recientes)</caption>
            <thead>
              <tr>
                <th scope="col">Identificación</th>
                <th scope="col">Año</th>
                <th scope="col">Versión</th>
                <th scope="col">Estado</th>
                <th scope="col">Tamaño</th>
                <th scope="col">Cargado</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.nIde}</td>
                  <td>{i.year}</td>
                  <td>{i.version}</td>
                  <td>
                    <Badge kind={i.active ? 'ok' : 'off'}>
                      {i.active ? 'Vigente' : 'Reemplazado'}
                    </Badge>
                  </td>
                  <td className="num">{Math.max(1, Math.round(i.sizeBytes / 1024))} KB</td>
                  <td>{formatDate(i.uploadedAt)}</td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    Todavía no hay certificados cargados.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
