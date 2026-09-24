'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR, api } from '@/lib/api';

type Mode = 'SIN_AJUSTE' | 'ENTERO_SUPERIOR';

interface Voucher {
  per: string;
  nLiq: number;
  contrato: string;
}

interface VoucherList {
  defaultMode: Mode;
  vouchers: Voucher[];
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

function label(v: Voucher): string {
  const month = MONTHS[Number(v.per.slice(4)) - 1] ?? v.per.slice(4);
  const quincena = v.nLiq === 1 ? 'primera quincena' : 'segunda quincena';
  return `${month} de ${v.per.slice(0, 4)} - ${quincena}`;
}

export default function PayslipsPage() {
  const [list, setList] = useState<VoucherList | null>(null);
  const [mode, setMode] = useState<Mode>('SIN_AJUSTE');
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await api<VoucherList>('/me/payroll');
    if (res.status === 200 && res.data) {
      setList(res.data);
      setMode(res.data.defaultMode);
    } else setError(NETWORK_ERROR);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const years = useMemo(
    () => [...new Set((list?.vouchers ?? []).map((v) => v.per.slice(0, 4)))],
    [list],
  );
  const shown = (list?.vouchers ?? []).filter((v) => !year || v.per.startsWith(year));

  return (
    <>
      <div className="page-head">
        <h1>Mis volantes de pago</h1>
        <p className="muted">
          Descargue sus volantes en PDF. Cada documento indica el modo de presentación que elija.
        </p>
      </div>

      {error ? (
        <>
          <Alert kind="error">{error}</Alert>
          <button type="button" onClick={() => void load()}>
            Reintentar
          </button>
        </>
      ) : null}
      {list === null && !error ? <Loading>Consultando sus volantes…</Loading> : null}

      {list !== null ? (
        <section className="panel">
          <fieldset className="modes">
            <legend>Modo de presentación del PDF</legend>
            <label className="choice">
              <input
                type="radio"
                name="mode"
                value="SIN_AJUSTE"
                checked={mode === 'SIN_AJUSTE'}
                onChange={() => setMode('SIN_AJUSTE')}
              />
              <span>
                <strong>Sin ajuste</strong>
                <span className="hint" style={{ display: 'block' }}>
                  Muestra los importes originales de la liquidación.
                </span>
              </span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="mode"
                value="ENTERO_SUPERIOR"
                checked={mode === 'ENTERO_SUPERIOR'}
                onChange={() => setMode('ENTERO_SUPERIOR')}
              />
              <span>
                <strong>Entero superior</strong>
                <span className="hint" style={{ display: 'block' }}>
                  Aproxima cada valor al entero superior. Solo cambia la presentación, no la
                  liquidación pagada.
                </span>
              </span>
            </label>
          </fieldset>

          {years.length > 1 ? (
            <div className="field" style={{ maxWidth: '14rem' }}>
              <label htmlFor="filtro-anio">Año</label>
              <select id="filtro-anio" value={year} onChange={(e) => setYear(e.target.value)}>
                <option value="">Todos</option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {list.vouchers.length === 0 ? (
            <EmptyState title="Todavía no hay volantes publicados para usted.">
              <p>
                Cuando Gestión Humana publique una liquidación en la que aparezca, podrá descargarla
                aquí.
              </p>
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState title="No hay volantes en ese año." />
          ) : (
            <ul className="vouchers">
              {shown.map((v) => (
                <li key={`${v.per}-${v.nLiq}-${v.contrato}`}>
                  <span>
                    <strong>{label(v)}</strong>
                    <span className="muted"> - contrato {v.contrato}</span>
                  </span>
                  <a
                    className="button secondary"
                    href={`/api/me/payroll/${v.per}/${v.nLiq}/${encodeURIComponent(v.contrato)}/pdf?mode=${mode}`}
                    download
                    aria-label={`Descargar PDF de ${label(v)}, contrato ${v.contrato}`}
                  >
                    Descargar PDF
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <div className="links">
        <Link href="/">Volver al inicio</Link>
      </div>
    </>
  );
}
