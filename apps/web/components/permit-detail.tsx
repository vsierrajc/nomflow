'use client';

import { longDate } from '@/lib/vacations';
import { PERMIT_ACTION, PERMIT_STATUS, permitWhen, type PermitDetail } from '@/lib/permits';

export function PermitDetailView({ detail }: { detail: PermitDetail }) {
  return (
    <div className="panel" aria-label={`Detalle del permiso de ${detail.employee}`}>
      <p>
        <strong>Tipo:</strong> {detail.typeName}
      </p>
      <p>
        <strong>Cuándo:</strong> {permitWhen(detail, longDate)}
      </p>
      <p>
        <strong>Estado:</strong> {PERMIT_STATUS[detail.status] ?? detail.status}
      </p>
      <p>
        <strong>Justificación:</strong> {detail.justification}
      </p>
      {detail.support ? (
        <p>
          <strong>Soporte:</strong>{' '}
          <a href={`/api/me/permits/${detail.id}/support`} download>
            Descargar {detail.support.fileName}
          </a>
        </p>
      ) : null}
      <h3>Historial</h3>
      <ol>
        {detail.actions.map((a, i) => (
          <li key={`${a.at}-${i}`}>
            {PERMIT_ACTION[a.action] ?? a.action}
            {a.byMe ? ' (usted)' : ''}, {longDate(a.at)}
            {a.comment ? `. Motivo: ${a.comment}` : ''}
          </li>
        ))}
      </ol>
    </div>
  );
}
