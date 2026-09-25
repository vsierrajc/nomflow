'use client';

import { ACTION_LABEL, STATUS_LABEL, longDate, type RequestDetail } from '@/lib/vacations';

/** Fechas de una revisión: distingue los días hábiles (que se descuentan) de la diferencia calendario. */
export function RevisionSummary({
  rev,
}: {
  rev: Pick<
    RequestDetail['revisions'][number],
    'start' | 'end' | 'businessDays' | 'calendarDiff' | 'returnDate'
  >;
}) {
  return (
    <dl className="stats">
      <div>
        <dt>Inicio del disfrute</dt>
        <dd>{longDate(rev.start)}</dd>
      </div>
      <div>
        <dt>Último día hábil de disfrute</dt>
        <dd>{longDate(rev.end)}</dd>
      </div>
      <div>
        <dt>Días hábiles (se descuentan de lo disponible)</dt>
        <dd>{rev.businessDays}</dd>
      </div>
      <div>
        <dt>Diferencia en días calendario</dt>
        <dd>{rev.calendarDiff}</dd>
      </div>
      <div>
        <dt>Fecha de retorno</dt>
        <dd>{longDate(rev.returnDate)}</dd>
      </div>
    </dl>
  );
}

export function VacationDetail({ detail }: { detail: RequestDetail }) {
  return (
    <div className="panel" aria-label={`Detalle de la solicitud de ${detail.employee ?? ''}`}>
      <p>
        <strong>Estado:</strong> {STATUS_LABEL[detail.status] ?? detail.status}
      </p>
      {detail.status === 'APROBADA' ? (
        <p>
          <a href={`/api/me/vacations/${detail.id}/pdf`} download>
            Descargar constancia (PDF)
          </a>
          {detail.documentArchived ? (
            <span className="muted">
              {' '}
              Archivo histórico: la descarga puede tardar unos segundos.
            </span>
          ) : null}
        </p>
      ) : null}
      {detail.revisions.map((r) => (
        <section key={r.number} aria-label={`Revisión ${r.number}`}>
          <h3>
            Revisión {r.number}
            {r.number === detail.revision ? ' (vigente)' : ''}
          </h3>
          {r.reason ? <p className="muted">Motivo del cambio: {r.reason}</p> : null}
          <RevisionSummary rev={r} />
          <ul>
            {r.allocations.map((a) => (
              <li key={a.progVacId}>
                Período {a.perIni} a {a.perFin}: {a.days} {a.days === 1 ? 'día' : 'días'} hábiles
              </li>
            ))}
          </ul>
        </section>
      ))}
      <h3>Historial</h3>
      <ol>
        {detail.actions.map((a, i) => (
          <li key={`${a.at}-${i}`}>
            {ACTION_LABEL[a.action] ?? a.action}
            {a.byMe ? ' (usted)' : ''}, revisión {a.revisionNumber}, {longDate(a.at)}
            {a.comment ? `. Motivo: ${a.comment}` : ''}
          </li>
        ))}
      </ol>
    </div>
  );
}
