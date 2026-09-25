'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, EmptyState, Field, Loading } from '@/components/ui';
import { NETWORK_ERROR, api } from '@/lib/api';
import { useReadyProfile } from '@/lib/use-profile';

type Kind = 'GENERAL' | 'DIRIGIDO';

interface Options {
  kinds: Kind[];
  company: string;
  maxPerDay: number;
}

interface Item {
  id: string;
  kind: Kind;
  addressee: string | null;
  docCode: string;
  docVersion: string;
  createdAt: string;
  archived?: boolean;
}

const fmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

const KIND_LABEL: Record<Kind, string> = {
  GENERAL: 'General (sin destinatario)',
  DIRIGIDO: 'Dirigido a una persona o entidad',
};

function problem(status: number, data: unknown): string {
  const d = (data ?? {}) as { code?: string; details?: string[] };
  if (status === 409 || d.code === 'NO_ACTIVE_CONTRACT')
    return 'Solo se expide certificado laboral con un contrato vigente. Si cree que es un error, consulte con Gestión Humana.';
  if (d.code === 'ADDRESSEE_REQUIRED')
    return 'Escriba a quién va dirigido el certificado (al menos 3 caracteres).';
  if (d.code === 'MODE_NOT_ALLOWED') return 'Esa modalidad no está habilitada. Recargue la página.';
  if (d.code === 'MISSING_DATA')
    return `No se pudo generar porque falta información en su ficha: ${(d.details ?? []).join(', ')}. Comuníquelo a Gestión Humana.`;
  if (d.code === 'LIMIT_REACHED')
    return 'Alcanzó el máximo de certificados por día. Intente de nuevo mañana.';
  if (status === 503)
    return 'El almacenamiento de documentos no está disponible ahora. Intente de nuevo en unos minutos.';
  return NETWORK_ERROR;
}

export default function LaborCertificatePage() {
  const profile = useReadyProfile();
  const [opts, setOpts] = useState<Options | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [kind, setKind] = useState<Kind>('GENERAL');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const load = useCallback(async () => {
    const [o, l] = await Promise.all([
      api<Options>('/me/labor-certificates/options'),
      api<Item[]>('/me/labor-certificates'),
    ]);
    if (o.status === 200 && o.data) {
      setOpts(o.data);
      setKind((k) => (o.data?.kinds.includes(k) ? k : (o.data?.kinds[0] ?? 'GENERAL')));
    } else {
      setBlocked(true);
      setError(problem(o.status, o.data));
    }
    if (l.status === 200 && l.data) setItems(l.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const addressee = String(new FormData(e.currentTarget).get('addressee') ?? '');
    setBusy(true);
    const res = await api<{ id: string }>('/me/labor-certificates', {
      method: 'POST',
      csrf: profile.csrfToken,
      body: { kind, ...(kind === 'DIRIGIDO' ? { addressee } : {}) },
    });
    setBusy(false);
    if (res.status === 201 && res.data) {
      setOk('Su certificado se generó. Puede verlo o descargarlo en la lista de abajo.');
      await load();
    } else setError(problem(res.status, res.data));
  }

  return (
    <>
      <div className="page-head">
        <h1>Certificado laboral</h1>
        <p className="muted">
          Genere en el momento su certificado laboral con los datos actuales de su contrato.
          {opts ? ` Se expide a nombre de ${opts.company}.` : ''}
        </p>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {ok ? <Alert kind="ok">{ok}</Alert> : null}
      {opts === null && !blocked ? <Loading>Consultando…</Loading> : null}

      {opts ? (
        <section className="panel" aria-labelledby="nuevo">
          <h2 id="nuevo">Generar un certificado</h2>
          <form onSubmit={generate} noValidate>
            {opts.kinds.length > 1 ? (
              <fieldset className="choice-group">
                <legend>Tipo de certificado</legend>
                {opts.kinds.map((k) => (
                  <label className="choice" key={k}>
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === k}
                      onChange={() => setKind(k)}
                    />
                    <span>{KIND_LABEL[k]}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p>
                <strong>Tipo de certificado:</strong> {KIND_LABEL[kind]}
              </p>
            )}
            {kind === 'DIRIGIDO' ? (
              <Field
                label="A quién va dirigido"
                name="addressee"
                required
                maxLength={200}
                hint="Nombre de la persona o entidad que recibirá el certificado. Por ejemplo: Banco Ejemplo S.A."
              />
            ) : null}
            <button type="submit" disabled={busy}>
              {busy ? 'Generando…' : 'Generar certificado'}
            </button>
          </form>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="historial">
        <h2 id="historial">Mis certificados</h2>
        {items.length === 0 ? (
          <EmptyState title="Aún no ha generado certificados.">
            <p>Los que genere quedarán aquí para volver a descargarlos.</p>
          </EmptyState>
        ) : (
          <ul className="vouchers">
            {items.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>
                    {c.kind === 'GENERAL' ? 'General' : `Dirigido a ${c.addressee ?? ''}`}
                  </strong>
                  <span className="muted">
                    {' '}
                    - {fmt.format(new Date(c.createdAt))} - {c.docCode} v{c.docVersion}
                    {c.archived
                      ? ' - Archivo histórico: la descarga puede tardar unos segundos.'
                      : ''}
                  </span>
                </span>
                <span className="toolbar">
                  <a
                    className="button secondary"
                    href={`/api/me/labor-certificates/${c.id}/pdf?inline=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Ver el certificado del ${fmt.format(new Date(c.createdAt))} (se abre en otra pestaña)`}
                  >
                    Ver
                  </a>
                  <a
                    className="button secondary"
                    href={`/api/me/labor-certificates/${c.id}/pdf`}
                    download
                    aria-label={`Descargar el certificado del ${fmt.format(new Date(c.createdAt))}`}
                  >
                    Descargar PDF
                  </a>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
