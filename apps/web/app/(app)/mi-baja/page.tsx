'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR, api } from '@/lib/api';
import { useReadyProfile } from '@/lib/use-profile';

interface Status {
  export: {
    status: string;
    readyAt: string | null;
    expiresAt: string | null;
    available: boolean;
  } | null;
}

const fmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

export default function MyExitPage() {
  useReadyProfile();
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<Status>('/me/exit/status');
    if (res.status === 200 && res.data) setData(res.data);
    else setError(NETWORK_ERROR);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1>Mi baja</h1>
      <p className="muted">
        Si su vinculación tiene una fecha prevista de baja, aquí puede descargar una copia de sus
        volantes de pago, certificados tributarios y constancias de vacaciones aprobadas mientras la
        exportación esté disponible.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {data === null ? (
        error ? null : (
          <Loading />
        )
      ) : !data.export ? (
        <EmptyState title="Sin novedades">
          No tiene una baja programada. Si cree que esto es un error, comuníquese con Gestión
          Humana.
        </EmptyState>
      ) : (
        <section className="import-panel" aria-label="Estado de la exportación">
          <p>
            Estado de su exportación: <strong>{data.export.status}</strong>
          </p>
          {data.export.readyAt ? (
            <p>Lista desde: {fmt.format(new Date(data.export.readyAt))}</p>
          ) : null}
          {data.export.expiresAt ? (
            <p>Disponible hasta: {fmt.format(new Date(data.export.expiresAt))}</p>
          ) : null}
          {data.export.available ? (
            <p>
              <a href="/api/me/exit/export/download">Descargar mi documentación (ZIP)</a>
            </p>
          ) : (
            <p className="muted">
              La exportación todavía no está lista o ya venció. Vuelva a intentarlo más tarde o
              comuníquese con Gestión Humana.
            </p>
          )}
        </section>
      )}
    </>
  );
}
