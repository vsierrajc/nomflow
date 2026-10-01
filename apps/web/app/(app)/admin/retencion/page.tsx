'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Summary {
  settings: {
    sessionsRetentionDays: number;
    verificationCodesRetentionDays: number;
    importStagingRetentionDays: number;
    autoEnabled: boolean;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunSummary: string | null;
  };
  preview: { sessions: number; verificationCodes: number; importRows: number; exports: number };
}

interface CertStatus {
  nIde: string;
  employeeActive: boolean;
  known: boolean;
  certificates: number;
  zipDownloads: number;
}

const ERRORS: Record<string, string> = {
  INVALID: 'Revise los datos: días enteros entre 1 y 3650.',
  EMPLOYEE_ACTIVE: 'La persona sigue activa: sus certificados no se pueden borrar.',
  NOT_CONFIRMED: 'El número de identificación de confirmación no coincide.',
  NOT_FOUND: 'No se encontró a la persona.',
};

const num = (n: number) => n.toLocaleString('es-CO');

export default function RetentionPage() {
  const { call } = useAdmin();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nIde, setNIde] = useState('');
  const [cert, setCert] = useState<CertStatus | null>(null);

  const load = useCallback(async () => {
    const res = await call<Summary>('/admin/data-retention');
    if (res.status === 200 && res.data) setData(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    const d = res.data as { code?: string } | undefined;
    if (res.status === 403 && !d?.code) setError('Se canceló la confirmación de identidad.');
    else setError(ERRORS[d?.code ?? ''] ?? NETWORK_ERROR);
  }

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call('/admin/data-retention/settings', {
      method: 'PUT',
      body: {
        sessionsRetentionDays: Number(f.get('sessionsRetentionDays')),
        verificationCodesRetentionDays: Number(f.get('verificationCodesRetentionDays')),
        importStagingRetentionDays: Number(f.get('importStagingRetentionDays')),
        autoEnabled: f.get('autoEnabled') === 'on',
      },
    });
    if (res.status === 200) {
      setOk('Política guardada.');
      await load();
    } else fail(res);
  }

  async function runNow() {
    setError(null);
    setOk(null);
    setBusy(true);
    const res = await call<{
      sessions: number;
      verificationCodes: number;
      importRows: number;
      exports: number;
    }>('/admin/data-retention/run', { method: 'POST', body: {} });
    setBusy(false);
    if (res.status === 200 && res.data) {
      const r = res.data;
      setOk(
        `Depuración hecha: ${num(r.sessions)} sesiones, ${num(r.verificationCodes)} códigos, ${num(r.importRows)} filas de importación y ${num(r.exports)} ZIP.`,
      );
      await load();
    } else fail(res);
  }

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    setCert(null);
    const res = await call<CertStatus>(
      `/admin/data-retention/certificates/${encodeURIComponent(nIde.trim())}`,
    );
    if (res.status === 200 && res.data) setCert(res.data);
    else fail(res);
  }

  async function removeCerts(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cert) return;
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const res = await call<{ deleted: number }>(
      `/admin/data-retention/certificates/${encodeURIComponent(cert.nIde)}`,
      { method: 'DELETE', body: { confirmNIde: String(f.get('confirmNIde') ?? '') } },
    );
    setBusy(false);
    if (res.status === 200 && res.data) {
      setOk(
        `Se borraron ${num(res.data.deleted)} certificado(s). Quedó una huella en la auditoría.`,
      );
      setCert(null);
      setNIde('');
    } else fail(res);
  }

  const s = data?.settings;
  const p = data?.preview;

  return (
    <>
      <PageHeader title="Retención de datos" />
      <p className="muted">
        Depura datos operativos que ya cumplieron su ciclo. Los certificados de retención nunca se
        borran solos: se conservan mientras la persona esté activa y solo un administrador puede
        borrarlos tras la baja.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      {s && p ? (
        <>
          <section className="import-panel" aria-label="Vencido hoy">
            <h2>Vencido hoy (vista previa)</h2>
            <ul>
              <li>Sesiones: {num(p.sessions)}</li>
              <li>Códigos de verificación: {num(p.verificationCodes)}</li>
              <li>Filas de preparación de importaciones: {num(p.importRows)}</li>
              <li>ZIP de baja caducados: {num(p.exports)}</li>
            </ul>
          </section>

          <section className="import-panel" aria-label="Política de retención de datos">
            <h2>Plazos</h2>
            <form onSubmit={saveSettings} noValidate key={JSON.stringify(s)}>
              <div className="grid-2">
                <Field
                  label="Conservar sesiones vencidas (días)"
                  name="sessionsRetentionDays"
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={s.sessionsRetentionDays}
                  required
                />
                <Field
                  label="Conservar códigos de verificación (días)"
                  name="verificationCodesRetentionDays"
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={s.verificationCodesRetentionDays}
                  required
                />
                <Field
                  label="Conservar filas de importación aplicadas (días)"
                  name="importStagingRetentionDays"
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={s.importStagingRetentionDays}
                  required
                  hint="Contienen datos personales y salarios."
                />
              </div>
              <label className="choice">
                <input type="checkbox" name="autoEnabled" defaultChecked={s.autoEnabled} />
                <span>Aplicar la política automáticamente una vez al día</span>
              </label>
              <div className="toolbar">
                <button type="submit">Guardar plazos</button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void runNow()}
                >
                  Depurar ahora
                </button>
              </div>
              <p className="muted">
                {s.lastRunAt
                  ? `Última aplicación: ${formatDate(s.lastRunAt)} (${s.lastRunStatus === 'OK' ? 'correcta' : 'con error'}). ${s.lastRunSummary ?? ''}`
                  : 'Aún no se ha aplicado.'}
              </p>
            </form>
          </section>
        </>
      ) : null}

      <section className="import-panel" aria-label="Certificados de retención de una persona">
        <h2>Certificados de retención de una persona dada de baja</h2>
        <form onSubmit={lookup} noValidate>
          <Field
            label="Número de identificación"
            name="nIde"
            value={nIde}
            onChange={(e) => setNIde(e.target.value)}
            required
          />
          <button type="submit" className="secondary">
            Consultar
          </button>
        </form>
        {cert ? (
          <form onSubmit={removeCerts} noValidate>
            <p>
              {cert.employeeActive
                ? 'La persona sigue activa: sus certificados se conservan.'
                : `Certificados guardados: ${num(cert.certificates)}. Descargas del ZIP de baja: ${num(cert.zipDownloads)}.`}
            </p>
            {!cert.employeeActive && cert.zipDownloads === 0 ? (
              <Notice kind="warn">
                Nadie ha descargado el ZIP de baja de esta persona. Si borra ahora, los certificados
                no se podrán recuperar.
              </Notice>
            ) : null}
            {!cert.employeeActive && cert.certificates > 0 ? (
              <>
                <Field
                  label="Repita el número de identificación para confirmar"
                  name="confirmNIde"
                  required
                />
                <button type="submit" className="danger" disabled={busy}>
                  Borrar certificados
                </button>
              </>
            ) : null}
          </form>
        ) : null}
      </section>
    </>
  );
}
