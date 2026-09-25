'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice } from '@/components/admin-ui';
import { Alert, EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Mine {
  id: string;
  cEmp: string;
  title: string;
  tier: 'PRINCIPAL' | 'RESPALDO';
  active: boolean;
  enrolled: boolean;
  consentAt: string | null;
}

const ERRORS: Record<string, string> = {
  INVALID_IMAGE:
    'La imagen no es válida. Use un PNG o JPEG de entre 100 y 2000 píxeles por lado, con la firma sobre fondo claro.',
  TOO_LARGE: 'La imagen supera los 300 KB.',
  CONSENT_REQUIRED: 'Debe marcar la autorización para cargar su firma.',
  NOT_A_SIGNER: 'No está designado como firmante de esa empresa.',
};

export default function SignerPage() {
  const { send, call } = useAdmin();
  const [items, setItems] = useState<Mine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    const res = await call<Mine[]>('/me/certificate-signer');
    if (res.status === 200 && res.data) setItems(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(id: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    if (!(f.get('file') instanceof File) || (f.get('file') as File).size === 0)
      return setError('Elija la imagen de su firma.');
    f.set('consent', f.get('consent') === 'on' ? 'true' : 'false');
    const res = await send(`/me/certificate-signer/${id}/signature`, f);
    if (res.status === 200) {
      setOk('Su firma quedó cargada y autorizada.');
      form.reset();
      setVersion((v) => v + 1);
      await load();
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[(res.data as { code?: string } | null)?.code ?? ''] ?? NETWORK_ERROR);
  }

  return (
    <>
      <div className="page-head">
        <h1>Mi firma de certificados</h1>
        <p className="muted">
          Usted fue designado(a) para firmar certificados laborales. Cargue una imagen de su firma y
          autorice su uso: NOMFLOW la insertará en los certificados que se expidan mientras usted
          sea firmante y esté disponible. Nadie más puede cargarla ni verla.
        </p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {items === null && !error ? <Loading>Consultando…</Loading> : null}
      {items !== null && items.length === 0 ? (
        <EmptyState title="No está designado como firmante.">
          <p>Gestión Humana o el administrador pueden designarle desde la administración.</p>
        </EmptyState>
      ) : null}
      {items?.map((s) => (
        <section className="panel" key={s.id} aria-label={`Firma como ${s.title}`}>
          <h2>
            {s.title}{' '}
            <Badge kind={s.enrolled && s.active ? 'ok' : 'warn'}>
              {!s.active ? 'Inactivo' : s.enrolled ? 'Firma cargada' : 'Falta su firma'}
            </Badge>
          </h2>
          <p className="muted">
            {s.tier === 'PRINCIPAL'
              ? 'Firmante principal.'
              : 'Firmante de respaldo: firma cuando no hay ningún principal disponible.'}{' '}
            {s.consentAt
              ? `Autorizó el uso de su firma el ${new Date(s.consentAt).toLocaleDateString('es-CO')}.`
              : ''}
          </p>
          {s.enrolled ? (
            <p>
              {/* La imagen solo la sirve la API a su titular. */}
              <img
                src={`/api/me/certificate-signer/${s.id}/signature?v=${version}`}
                alt="Su firma actual"
                style={{
                  maxWidth: '16rem',
                  border: '1px solid var(--color-border)',
                  background: '#fff',
                }}
              />
            </p>
          ) : null}
          <form onSubmit={(e) => void upload(s.id, e)} noValidate>
            <div className="field">
              <label htmlFor={`file-${s.id}`}>Imagen de su firma (PNG o JPEG)</label>
              <input id={`file-${s.id}`} name="file" type="file" accept="image/png,image/jpeg" />
              <p className="hint">
                Firma sobre fondo blanco, de 100 a 2000 píxeles por lado y hasta 300 KB.
              </p>
            </div>
            <label className="choice">
              <input type="checkbox" name="consent" />
              <span>
                Autorizo que NOMFLOW inserte esta firma, con mi nombre y cargo, en los certificados
                laborales que se emitan mientras yo sea firmante.
              </span>
            </label>
            <button type="submit">{s.enrolled ? 'Reemplazar mi firma' : 'Cargar mi firma'}</button>
          </form>
        </section>
      ))}
      <Alert kind="info">
        Al cargar o reemplazar su firma se le pedirá confirmar su clave, y queda registrado quién la
        cargó, cuándo y con qué huella.
      </Alert>
    </>
  );
}
