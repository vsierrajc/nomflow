'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Card } from '../../components/ui';
import { NETWORK_ERROR, api } from '../../lib/api';
import { useProfile } from '../../lib/use-profile';

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
  const router = useRouter();
  const { state } = useProfile();
  const [list, setList] = useState<VoucherList | null>(null);
  const [mode, setMode] = useState<Mode>('SIN_AJUSTE');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
  }, [state, router]);

  useEffect(() => {
    if (state.status !== 'ready') return;
    void (async () => {
      const res = await api<VoucherList>('/me/payroll');
      if (res.status === 200 && res.data) {
        setList(res.data);
        setMode(res.data.defaultMode);
      } else if (res.status === 401) router.replace('/login');
      else setError(NETWORK_ERROR);
    })();
  }, [state, router]);

  if (state.status === 'loading' || state.status === 'anonymous') {
    return <Card title="Mis volantes de pago">Cargando…</Card>;
  }

  return (
    <Card title="Mis volantes de pago">
      {error ? <Alert kind="error">{error}</Alert> : null}
      {list === null && !error ? <p className="muted">Cargando…</p> : null}
      {list !== null ? (
        <>
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
              Sin ajuste: importes originales
            </label>
            <label className="choice">
              <input
                type="radio"
                name="mode"
                value="ENTERO_SUPERIOR"
                checked={mode === 'ENTERO_SUPERIOR'}
                onChange={() => setMode('ENTERO_SUPERIOR')}
              />
              Entero superior: cada valor sube al entero
            </label>
            <p className="hint">
              El ajuste es solo de presentación: no modifica la liquidación pagada. El PDF indica el
              modo elegido.
            </p>
          </fieldset>

          {list.vouchers.length === 0 ? (
            <p className="muted">Todavía no hay volantes publicados para usted.</p>
          ) : (
            <ul className="vouchers">
              {list.vouchers.map((v) => (
                <li key={`${v.per}-${v.nLiq}-${v.contrato}`}>
                  <span>
                    {label(v)} <span className="muted">- contrato {v.contrato}</span>
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
        </>
      ) : null}
      <div className="links">
        <Link href="/">Volver al inicio</Link>
      </div>
    </Card>
  );
}
