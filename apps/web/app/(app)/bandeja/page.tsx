'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR, api } from '@/lib/api';

interface Task {
  kind: string;
  id: string;
  action: string;
  who: string;
  detail: string;
  since: string;
  href: string;
}

interface Flow {
  kind: 'VACACION' | 'PERMISO';
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  steps: { label: string; state: 'done' | 'current' | 'todo' | 'rejected' | 'cancelled' }[];
  since: string;
  href: string;
}

const STATE_TEXT: Record<Flow['steps'][number]['state'], string> = {
  done: 'completado',
  current: 'paso actual',
  todo: 'pendiente',
  rejected: 'rechazado',
  cancelled: 'cancelado',
};

const fmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Bogota',
});
const when = (iso: string) => fmt.format(new Date(iso));

/** Cuántos días lleva esperando, para priorizar. */
function waiting(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Llegó hoy';
  return days === 1 ? 'Espera desde hace 1 día' : `Espera desde hace ${days} días`;
}

export default function InboxPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await api<{ tasks: Task[]; flows: Flow[] }>('/me/inbox');
    if (res.status === 200 && res.data) {
      setTasks(res.data.tasks);
      setFlows(res.data.flows);
    } else setError(NETWORK_ERROR);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>Bandeja de entrada</h1>
        <p className="muted">
          Aquí están las actividades que esperan una acción suya y el avance de sus propias
          solicitudes dentro del flujo de aprobación.
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
      {tasks === null && !error ? <Loading>Consultando su bandeja…</Loading> : null}

      {tasks !== null ? (
        <section className="panel" aria-labelledby="pendientes">
          <h2 id="pendientes">
            Pendientes por su acción <span className="count-pill">{tasks.length}</span>
          </h2>
          {tasks.length === 0 ? (
            <EmptyState title="No tiene actividades pendientes.">
              <p>Cuando una solicitud espere su decisión, aparecerá aquí.</p>
            </EmptyState>
          ) : (
            <ul className="vouchers inbox-list">
              {tasks.map((t) => (
                <li key={`${t.kind}-${t.id}`} data-testid="inbox-task">
                  <span>
                    <strong>{t.action}</strong>
                    <span className="muted">
                      {' '}
                      - {t.who}
                      {t.detail ? `, ${t.detail}` : ''}
                    </span>
                    <br />
                    <span className="muted">
                      {waiting(t.since)} ({when(t.since)})
                    </span>
                  </span>
                  <span className="toolbar">
                    <Link className="button" href={t.href}>
                      Abrir
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tasks !== null ? (
        <section className="panel" aria-labelledby="seguimiento">
          <h2 id="seguimiento">Mis solicitudes en el flujo</h2>
          {flows.length === 0 ? (
            <EmptyState title="No tiene solicitudes en trámite.">
              <p>
                Las vacaciones y permisos que envíe, y los resueltos en los últimos días, se ven
                aquí.
              </p>
            </EmptyState>
          ) : (
            <ul className="flow-list">
              {flows.map((f) => (
                <li key={`${f.kind}-${f.id}`} data-testid="inbox-flow">
                  <p>
                    <strong>{f.title}</strong> <span className="muted">- {f.statusLabel}</span>{' '}
                    <Link href={f.href}>Ver</Link>
                  </p>
                  <ol className="stepper" aria-label={`Avance: ${f.statusLabel}`}>
                    {f.steps.map((s) => (
                      <li key={s.label} className={`step step-${s.state}`}>
                        <span className="step-dot" aria-hidden="true" />
                        <span>
                          {s.label}
                          <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </>
  );
}
