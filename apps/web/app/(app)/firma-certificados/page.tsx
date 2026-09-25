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
  digital: boolean;
  digitalExpired: boolean;
  digitalSubject: string | null;
  digitalFingerprint: string | null;
  digitalNotAfter: string | null;
  digitalOrigin: 'AUTOFIRMADO' | 'CARGADO' | null;
}

const ERRORS: Record<string, string> = {
  INVALID_IMAGE:
    'La imagen no es válida. Use un PNG o JPEG de entre 100 y 2000 píxeles por lado, con la firma sobre fondo claro.',
  TOO_LARGE: 'La imagen supera los 300 KB.',
  CONSENT_REQUIRED: 'Debe marcar la autorización para cargar su firma.',
  NOT_A_SIGNER: 'No está designado como firmante de esa empresa.',
  INVALID_P12: 'El archivo no es un certificado .p12/.pfx válido con su clave privada.',
  WRONG_PASSPHRASE: 'La clave del archivo es incorrecta.',
  EXPIRED_CERT: 'Ese certificado ya está vencido.',
  WEAK_KEY: 'La clave del certificado es débil (se exigen 2048 bits o más).',
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

  async function digitalUpload(id: string, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    if (!(f.get('file') instanceof File) || (f.get('file') as File).size === 0)
      return setError('Elija su certificado (.p12 o .pfx).');
    f.set('consent', f.get('consent') === 'on' ? 'true' : 'false');
    const res = await send(`/me/certificate-signer/${id}/digital`, f);
    if (res.status === 200) {
      setOk('Su firma digital quedó cargada y autorizada.');
      form.reset();
      await load();
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[(res.data as { code?: string } | null)?.code ?? ''] ?? NETWORK_ERROR);
  }

  async function digitalAction(id: string, path: string, body: object, done: string) {
    setError(null);
    setOk(null);
    const res = await call(`/me/certificate-signer/${id}/${path}`, { method: 'POST', body });
    if (res.status === 200) {
      setOk(done);
      await load();
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[(res.data as { code?: string } | null)?.code ?? ''] ?? NETWORK_ERROR);
  }

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
            <Badge kind={(s.enrolled || s.digital) && s.active ? 'ok' : 'warn'}>
              {!s.active ? 'Inactivo' : s.enrolled || s.digital ? 'Puede firmar' : 'Falta su firma'}
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
          <h3>Firma digital criptográfica (opcional)</h3>
          <p className="muted">
            Además de la imagen, el PDF puede llevar una firma digital que permite comprobar quién
            lo firmó y que no fue alterado después. Puede subir su certificado personal (.p12 o
            .pfx, de una entidad de certificación) o generar un certificado autofirmado de NOMFLOW,
            útil para pruebas o uso interno: no lo respalda una entidad de certificación acreditada.
          </p>
          {s.digital ? (
            <p>
              <Badge kind="ok">Firma digital vigente</Badge>{' '}
              {s.digitalOrigin === 'AUTOFIRMADO'
                ? 'Certificado autofirmado (pruebas). '
                : 'Certificado cargado. '}
              {s.digitalSubject} - vence el{' '}
              {s.digitalNotAfter ? new Date(s.digitalNotAfter).toLocaleDateString('es-CO') : ''}.{' '}
              <span className="muted">Huella {s.digitalFingerprint?.slice(0, 16)}…</span>
            </p>
          ) : s.digitalExpired ? (
            <p>
              <Badge kind="off">Certificado vencido</Badge> Cargue o genere uno nuevo.
            </p>
          ) : (
            <p>
              <Badge kind="warn">Sin firma digital</Badge>
            </p>
          )}
          <div className="toolbar">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void digitalAction(
                  s.id,
                  'digital/generate',
                  { consent: true },
                  'Se generó su certificado autofirmado y quedó autorizado.',
                )
              }
            >
              Generar certificado autofirmado (pruebas)
            </button>
            {s.digital ? (
              <>
                <a
                  className="button secondary"
                  href={`/api/me/certificate-signer/${s.id}/digital/certificate`}
                  download
                >
                  Descargar mi certificado público
                </a>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void digitalAction(s.id, 'digital/remove', {}, 'Se retiró su firma digital.')
                  }
                >
                  Retirar firma digital
                </button>
              </>
            ) : null}
          </div>
          <form onSubmit={(e) => void digitalUpload(s.id, e)} noValidate>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`p12-${s.id}`}>Certificado personal (.p12 o .pfx)</label>
                <input
                  id={`p12-${s.id}`}
                  name="file"
                  type="file"
                  accept=".p12,.pfx,application/x-pkcs12"
                />
              </div>
              <div className="field">
                <label htmlFor={`pass-${s.id}`}>Clave del certificado</label>
                <input id={`pass-${s.id}`} name="passphrase" type="password" autoComplete="off" />
                <p className="hint">Se guarda cifrada en el servidor y no se vuelve a mostrar.</p>
              </div>
            </div>
            <label className="choice">
              <input type="checkbox" name="consent" />
              <span>
                Autorizo que NOMFLOW firme digitalmente con este certificado los certificados
                laborales que se emitan mientras yo sea firmante.
              </span>
            </label>
            <button type="submit">Cargar mi certificado digital</button>
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
