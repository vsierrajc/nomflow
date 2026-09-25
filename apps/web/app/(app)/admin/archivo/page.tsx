'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field, PasswordField } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Overview {
  settings: {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string | null;
    hasSecret: boolean;
    configured: boolean;
    ageDays: number;
    graceDays: number;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunSummary: string | null;
    updatedAt: string | null;
  };
  stats: {
    totalObjects: number;
    onlyInCloud: number;
    inBoth: number;
    cloudBytes: number;
    eligible: number;
  };
}

const ERRORS: Record<string, string> = {
  INVALID_SETTINGS:
    'Revise los datos: dirección https, región (por ejemplo us-central1), nombre de bucket válido, edad de al menos 30 días y días de gracia entre 0 y 365.',
  NOT_CONFIGURED: 'Guarde primero la clave de acceso y el secreto del bucket.',
  NOT_ENABLED: 'Active el archivado y guarde antes de ejecutarlo.',
  UNAVAILABLE:
    'El bucket respondió con un error que no se pudo identificar. Revise la dirección, el nombre del bucket y las claves.',
  UNREACHABLE:
    'No se pudo llegar al servicio. Revise la dirección (https://storage.googleapis.com) y que el servidor tenga salida a internet.',
  ACCESS_DENIED:
    'Google reconoce las claves, pero la cuenta no tiene permiso sobre el bucket. En Google Cloud, otorgue a la cuenta de servicio el rol «Storage Object Admin» (roles/storage.objectAdmin) sobre este bucket: hacen falta crear, leer, listar y borrar objetos.',
  INVALID_KEYS:
    'Google no acepta las claves: la clave de acceso y el secreto HMAC no coinciden o no existen. Genere una clave HMAC nueva para la cuenta de servicio y vuelva a pegar ambos valores.',
  NO_SUCH_BUCKET:
    'El bucket no existe con ese nombre. Revise el nombre exacto del bucket en Google Cloud (distingue el proyecto y no admite mayúsculas).',
  MISMATCH: 'El bucket respondió, pero lo leído no coincide con lo escrito. Revise los permisos.',
  BUSY: 'Ya hay un archivado en curso. Espere a que termine.',
};

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;

export default function ArchivePage() {
  const { call } = useAdmin();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await call<Overview>('/admin/archive');
    if (res.status === 200 && res.data) setData(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    const code = (res.data as { code?: string } | undefined)?.code ?? '';
    if (res.status === 403 && !code) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[code] ?? NETWORK_ERROR);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const secret = String(f.get('secret') ?? '');
    const res = await call<Overview>('/admin/archive/settings', {
      method: 'PUT',
      body: {
        enabled: f.get('enabled') === 'on',
        endpoint: String(f.get('endpoint') ?? ''),
        region: String(f.get('region') ?? ''),
        bucket: String(f.get('bucket') ?? ''),
        accessKeyId: String(f.get('accessKeyId') ?? ''),
        ...(secret ? { secret } : {}),
        ageDays: Number(f.get('ageDays')),
        graceDays: Number(f.get('graceDays')),
      },
    });
    if (res.status === 200 && res.data) {
      setData(res.data);
      setOk('Configuración guardada.');
    } else fail(res);
  }

  async function test() {
    setError(null);
    setOk(null);
    setBusy('test');
    const res = await call('/admin/archive/test', { method: 'POST' });
    setBusy(null);
    if (res.status === 200)
      setOk('Conexión correcta: se escribió, leyó y borró un objeto de prueba.');
    else fail(res);
  }

  async function runNow() {
    setError(null);
    setOk(null);
    setBusy('run');
    const res = await call<{ copied: number; deletedLocal: number; failed: number }>(
      '/admin/archive/run',
      { method: 'POST' },
    );
    setBusy(null);
    if (res.status === 200 && res.data)
      setOk(
        `Archivado terminado: ${res.data.copied} copiados, ${res.data.deletedLocal} liberados de local, ${res.data.failed} con fallo.`,
      );
    else fail(res);
    await load();
  }

  const s = data?.settings;
  return (
    <>
      <PageHeader title="Archivo histórico en la nube" />
      <p className="muted">
        Los certificados y constancias con más de un año se copian a un bucket de Google Cloud
        Storage, se verifica la copia y solo entonces se liberan del almacenamiento local. Lo
        reciente sigue en local; lo histórico se consulta desde la nube de forma transparente, con
        un aviso de que puede tardar unos segundos. Los archivos viajan ya cifrados por NOMFLOW.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      {data === null || !s ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <section className="import-panel" aria-label="Estado del archivo">
            <h2>Estado</h2>
            <div className="cards">
              <div className="stat">
                <strong>{data.stats.totalObjects}</strong>Documentos guardados
              </div>
              <div className="stat">
                <strong>{data.stats.onlyInCloud}</strong>Solo en la nube (
                {mb(data.stats.cloudBytes)})
              </div>
              <div className="stat">
                <strong>{data.stats.inBoth}</strong>En local y en la nube
              </div>
              <div className="stat">
                <strong>{data.stats.eligible}</strong>Listos para archivar
              </div>
            </div>
            <p className="muted">
              {s.lastRunAt
                ? `Última ejecución: ${formatDate(s.lastRunAt)}. ${s.lastRunSummary ?? ''}`
                : 'Aún no se ha ejecutado.'}
            </p>
            <div className="toolbar">
              <button type="button" onClick={() => void test()} disabled={busy !== null}>
                {busy === 'test' ? 'Probando…' : 'Probar conexión'}
              </button>
              <button type="button" onClick={() => void runNow()} disabled={busy !== null}>
                {busy === 'run' ? 'Archivando…' : 'Archivar ahora'}
              </button>
            </div>
          </section>

          <section className="import-panel" aria-label="Configuración del bucket">
            <h2>Bucket y reglas</h2>
            <form onSubmit={save} noValidate key={s.updatedAt ?? 'nuevo'}>
              <label className="choice">
                <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
                <span>Activar el archivado automático (una vez al día)</span>
              </label>
              <div className="grid-2">
                <Field
                  label="Dirección del servicio S3"
                  name="endpoint"
                  defaultValue={s.endpoint}
                  required
                  hint="Google Cloud Storage: https://storage.googleapis.com"
                />
                <Field label="Región" name="region" defaultValue={s.region} required />
                <Field label="Nombre del bucket" name="bucket" defaultValue={s.bucket} required />
                <Field
                  label="Clave de acceso (HMAC)"
                  name="accessKeyId"
                  defaultValue={s.accessKeyId ?? ''}
                  autoComplete="off"
                  optional
                />
                <PasswordField
                  label="Secreto (HMAC)"
                  name="secret"
                  autoComplete="new-password"
                  hint={
                    s.hasSecret
                      ? 'Ya hay un secreto guardado. Escriba uno nuevo solo para reemplazarlo.'
                      : 'Se guarda cifrado y no se vuelve a mostrar.'
                  }
                />
                <Field
                  label="Archivar lo que tenga más de (días)"
                  name="ageDays"
                  type="number"
                  min={30}
                  max={3650}
                  defaultValue={s.ageDays}
                  required
                  hint="365 = un año."
                />
                <Field
                  label="Días en local tras verificar la copia"
                  name="graceDays"
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={s.graceDays}
                  required
                  hint="0 = se libera de local en cuanto la copia en la nube se verifica."
                />
              </div>
              <button type="submit">Guardar configuración</button>
            </form>
          </section>
        </>
      )}
    </>
  );
}
