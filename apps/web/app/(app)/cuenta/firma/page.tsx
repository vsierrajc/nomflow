'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, formatDate } from '@/components/admin-ui';
import { EmptyState, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface State {
  eligible: boolean;
  enrolled: boolean;
  consentAt: string | null;
  sha256: string | null;
}

const ERRORS: Record<string, string> = {
  INVALID_IMAGE:
    'La imagen no es válida. Use un PNG o JPEG de entre 100 y 2000 píxeles por lado, con la firma sobre fondo claro.',
  TOO_LARGE: 'La imagen supera los 300 KB.',
  CONSENT_REQUIRED: 'Debe marcar la autorización para cargar su firma.',
  NOT_APPROVER: 'Solo quienes aprueban solicitudes de vacaciones pueden cargar esta firma.',
  NOT_FOUND: 'No tiene una firma cargada.',
};

/** Quien aprueba vacaciones carga la firma que aparecerá en la constancia de lo que apruebe. */
export default function ApproverSignaturePage() {
  const { send, call } = useAdmin();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    const res = await call<State>('/me/approver-signature');
    if (res.status === 200 && res.data) setState(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    if (res.status === 403 && !(res.data as { code?: string } | null)?.code)
      setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[(res.data as { code?: string } | null)?.code ?? ''] ?? NETWORK_ERROR);
  }

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    if (!(f.get('file') instanceof File) || (f.get('file') as File).size === 0)
      return setError('Elija la imagen de su firma.');
    f.set('consent', f.get('consent') === 'on' ? 'true' : 'false');
    const res = await send('/me/approver-signature', f);
    if (res.status === 200) {
      setOk('Su firma quedó cargada y autorizada.');
      form.reset();
      setVersion((v) => v + 1);
      await load();
    } else fail(res);
  }

  async function remove() {
    setError(null);
    setOk(null);
    const res = await call('/me/approver-signature', { method: 'DELETE' });
    if (res.status === 204) {
      setOk('Retiró su firma. Las constancias que se emitan desde ahora saldrán sin ella.');
      setVersion((v) => v + 1);
      await load();
    } else fail(res);
  }

  return (
    <>
      <div className="page-head">
        <h1>Mi firma de aprobación</h1>
        <p className="muted">
          Cuando usted aprueba una solicitud de vacaciones, NOMFLOW puede insertar su firma, con su
          nombre y cargo, en la constancia. Cargue una imagen de su firma y autorice su uso. Nadie
          más puede cargarla ni verla. Las constancias ya emitidas no cambian si la retira o la
          reemplaza.
        </p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {state === null && !error ? <Loading>Consultando…</Loading> : null}
      {state !== null && !state.eligible ? (
        <EmptyState title="No tiene un rol que apruebe vacaciones.">
          <p>Esta firma solo la cargan quienes deciden solicitudes de vacaciones.</p>
        </EmptyState>
      ) : null}
      {state?.eligible ? (
        <section className="panel" aria-labelledby="firma-estado">
          <h2 id="firma-estado">
            Firma en la constancia{' '}
            <Badge kind={state.enrolled ? 'ok' : 'warn'}>
              {state.enrolled ? 'Cargada' : 'Falta su firma'}
            </Badge>
          </h2>
          {state.enrolled ? (
            <>
              <p className="muted">
                Autorizó su uso el {formatDate(state.consentAt)}.{' '}
                <span>Huella {state.sha256?.slice(0, 16)}…</span>
              </p>
              <p>
                {/* La imagen solo la sirve la API a su titular. */}
                <img
                  key={version}
                  src={`/api/me/approver-signature/image?v=${version}`}
                  alt="Su firma cargada"
                  style={{ maxWidth: '16rem', maxHeight: '6rem', background: '#fff' }}
                />
              </p>
            </>
          ) : (
            <p className="muted">
              Sin firma cargada, la constancia sale con su nombre y la fecha de su aprobación, pero
              sin imagen de firma.
            </p>
          )}
          <form onSubmit={(e) => void upload(e)} noValidate>
            <div className="field">
              <label htmlFor="firma-archivo">Imagen de su firma (PNG o JPEG)</label>
              <input id="firma-archivo" name="file" type="file" accept="image/png,image/jpeg" />
              <p className="hint">
                Firma sobre fondo blanco, de 100 a 2000 píxeles por lado y hasta 300 KB.
              </p>
            </div>
            <label className="choice">
              <input type="checkbox" name="consent" />
              <span>
                Autorizo que NOMFLOW inserte esta firma, con mi nombre y cargo, en las constancias
                de las solicitudes de vacaciones que yo apruebe.
              </span>
            </label>
            <div className="toolbar">
              <button type="submit">
                {state.enrolled ? 'Reemplazar mi firma' : 'Cargar mi firma'}
              </button>
              {state.enrolled ? (
                <button type="button" className="secondary" onClick={() => void remove()}>
                  Retirar mi firma
                </button>
              ) : null}
            </div>
          </form>
        </section>
      ) : null}
    </>
  );
}
