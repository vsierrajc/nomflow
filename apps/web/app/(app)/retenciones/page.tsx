'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR, api } from '@/lib/api';

interface Certificate {
  year: number;
  sizeBytes: number;
  uploadedAt: string;
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export default function TaxCertificatesPage() {
  const [items, setItems] = useState<Certificate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await api<Certificate[]>('/me/tax-certificates');
    if (res.status === 200 && res.data) setItems(res.data);
    else setError(NETWORK_ERROR);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>Mis certificados de retención</h1>
        <p className="muted">Visualice o descargue su certificado de retención de cada año.</p>
      </div>
      {error ? (
        <>
          <Alert kind="error">{error}</Alert>
          <button type="button" onClick={() => void load()}>
            Reintentar
          </button>
        </>
      ) : null}
      {items === null && !error ? <Loading>Consultando sus certificados…</Loading> : null}
      {items !== null ? (
        <section className="panel">
          {items.length === 0 ? (
            <EmptyState title="Todavía no hay certificados de retención para usted.">
              <p>Cuando Gestión Humana los publique, podrá consultarlos aquí.</p>
            </EmptyState>
          ) : (
            <ul className="vouchers">
              {items.map((c) => (
                <li key={c.year}>
                  <span>
                    <strong>Año {c.year}</strong>
                    <span className="muted"> - PDF, {kb(c.sizeBytes)}</span>
                  </span>
                  <span className="toolbar">
                    <a
                      className="button secondary"
                      href={`/api/me/tax-certificates/${c.year}/pdf?inline=1`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Ver certificado de retención ${c.year} (se abre en otra pestaña)`}
                    >
                      Ver
                    </a>
                    <a
                      className="button secondary"
                      href={`/api/me/tax-certificates/${c.year}/pdf`}
                      download
                      aria-label={`Descargar certificado de retención ${c.year}`}
                    >
                      Descargar PDF
                    </a>
                  </span>
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
