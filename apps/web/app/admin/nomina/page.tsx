'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, SelectField, formatDate } from '../../../components/admin-ui';
import { Field } from '../../../components/ui';
import { NETWORK_ERROR } from '../../../lib/api';
import { useAdmin } from '../../../lib/admin';

interface Version {
  id: string;
  per: string;
  nLiq: number;
  version: number;
  status: string;
  rowCount: number;
  totalDev: string;
  totalDed: string;
  publishedAt: string;
}

interface Voucher {
  per: string;
  nLiq: number;
  contrato: string;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const label = (per: string, nLiq: number) =>
  `${MONTHS[Number(per.slice(4)) - 1] ?? per.slice(4)} de ${per.slice(0, 4)} - ${nLiq === 1 ? 'primera' : 'segunda'} quincena`;
const money = (v: string) =>
  new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(
    Number(v),
  );

export default function PayrollPage() {
  const { call, download } = useAdmin();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nIde, setNIde] = useState('');
  const [vouchers, setVouchers] = useState<Voucher[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [mode, setMode] = useState('SIN_AJUSTE');
  const [reason, setReason] = useState('');
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await call<Version[]>('/admin/imports/payroll/versions');
      if (res.status === 200 && res.data) setVersions(res.data);
      else setError(NETWORK_ERROR);
    })();
  }, [call]);

  async function lookup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const id = String(new FormData(e.currentTarget).get('nIde') ?? '').trim();
    setVouchers(null);
    setLookupError(null);
    setOk(null);
    const res = await call<Voucher[]>(
      `/admin/payroll/employees/${encodeURIComponent(id)}/vouchers`,
    );
    if (res.status === 200 && res.data) {
      setNIde(id);
      setVouchers(res.data);
    } else if (res.status === 404) setLookupError('No hay ningún empleado con esa identificación.');
    else setLookupError(NETWORK_ERROR);
  }

  async function get(v: Voucher) {
    setLookupError(null);
    setOk(null);
    if (reason.trim().length < 10) {
      setLookupError(
        'Escriba el motivo del acceso (mínimo 10 caracteres). Queda registrado en la auditoría.',
      );
      return;
    }
    const path = `/admin/payroll/employees/${encodeURIComponent(nIde)}/${v.per}/${v.nLiq}/${encodeURIComponent(v.contrato)}/pdf?mode=${mode}&reason=${encodeURIComponent(reason.trim())}`;
    const res = await download(path);
    if (res.status === 200 && res.blob) {
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename ?? `volante-${v.per}-q${v.nLiq}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOk('Volante descargado. El acceso quedó registrado con su motivo.');
    } else if (res.status === 400)
      setLookupError('Revise el motivo (mínimo 10 caracteres) y el modo.');
    else if (res.status === 403) setLookupError('Se canceló la confirmación de identidad.');
    else if (res.status === 404) setLookupError('Ese volante ya no está publicado.');
    else setLookupError(NETWORK_ERROR);
  }

  return (
    <>
      <PageHeader title="Nómina publicada" />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {versions === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Versiones de liquidaciones (una sola publicada por período y quincena)"
        >
          <table>
            <caption className="muted">
              Versiones de liquidaciones (una sola publicada por período y quincena)
            </caption>
            <thead>
              <tr>
                <th scope="col">Período</th>
                <th scope="col">Versión</th>
                <th scope="col">Estado</th>
                <th scope="col">Filas</th>
                <th scope="col">Total devengado</th>
                <th scope="col">Total deducido</th>
                <th scope="col">Publicada</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>{label(v.per, v.nLiq)}</td>
                  <td>{v.version}</td>
                  <td>
                    {v.status === 'PUBLICADA' ? (
                      <Badge kind="ok">Publicada</Badge>
                    ) : (
                      <Badge kind="off">
                        {v.status === 'REEMPLAZADA' ? 'Reemplazada' : v.status}
                      </Badge>
                    )}
                  </td>
                  <td className="num">{v.rowCount}</td>
                  <td className="num">{money(v.totalDev)}</td>
                  <td className="num">{money(v.totalDed)}</td>
                  <td>{formatDate(v.publishedAt)}</td>
                </tr>
              ))}
              {versions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    Todavía no hay nómina publicada. Impórtela desde «Importaciones».
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <section className="import-panel" aria-label="Volantes de otras personas">
        <h2>Consultar el volante de una persona</h2>
        <p className="muted">
          Como administrador puede descargar el volante de cualquier empleado, vigente o cancelado.
          Cada acceso exige un motivo y queda registrado en la auditoría.
        </p>
        {lookupError ? <Notice kind="error">{lookupError}</Notice> : null}
        {ok ? <Notice kind="ok">{ok}</Notice> : null}
        <form onSubmit={lookup} className="toolbar" noValidate>
          <Field label="Identificación del empleado" name="nIde" required maxLength={30} />
          <button type="submit">Buscar volantes</button>
        </form>
        {vouchers ? (
          vouchers.length === 0 ? (
            <p className="muted">Esa persona no tiene volantes publicados.</p>
          ) : (
            <>
              <div className="grid-2">
                <SelectField
                  label="Modo de presentación"
                  name="mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'SIN_AJUSTE', label: 'Sin ajuste (importes originales)' },
                    { value: 'ENTERO_SUPERIOR', label: 'Entero superior' },
                  ]}
                />
                <div className="field">
                  <label htmlFor="voucher-reason">Motivo del acceso (mínimo 10 caracteres)</label>
                  <textarea
                    id="voucher-reason"
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                  />
                </div>
              </div>
              <ul className="vouchers">
                {vouchers.map((v) => (
                  <li key={`${v.per}-${v.nLiq}-${v.contrato}`}>
                    <span>
                      {label(v.per, v.nLiq)} <span className="muted">- contrato {v.contrato}</span>
                    </span>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void get(v)}
                      aria-label={`Descargar volante de ${label(v.per, v.nLiq)}, contrato ${v.contrato}`}
                    >
                      Descargar PDF
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : null}
      </section>
    </>
  );
}
