'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Settings {
  preBajaAvisoDias: number;
  zipExpiryDays: number;
  updatedAt: string | null;
}

interface Schedule {
  id: string;
  nIde: string;
  plannedDate: string;
  reason: string;
  status: 'PENDIENTE' | 'AVISADO' | 'EJECUTADO' | 'CANCELADO';
  noticeSentAt: string | null;
  exportId: string | null;
}

interface ExportRow {
  id: string;
  status: 'PENDIENTE' | 'GENERANDO' | 'LISTO' | 'INCOMPLETO' | 'ERROR';
  requestKind: string;
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  missingReport: string[] | null;
}

const BADGE: Record<Schedule['status'], 'ok' | 'warn' | 'off'> = {
  PENDIENTE: 'warn',
  AVISADO: 'ok',
  EJECUTADO: 'off',
  CANCELADO: 'off',
};

const EXPORT_BADGE: Record<ExportRow['status'], 'ok' | 'warn' | 'off'> = {
  PENDIENTE: 'warn',
  GENERANDO: 'warn',
  LISTO: 'ok',
  INCOMPLETO: 'warn',
  ERROR: 'off',
};

export default function ExitPage() {
  const { call, download } = useAdmin();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [exportsByNIde, setExportsByNIde] = useState<Record<string, ExportRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, sc] = await Promise.all([
      call<Settings>('/admin/exit/settings'),
      call<Schedule[]>('/admin/exit/schedule'),
    ]);
    if (s.status === 200 && s.data) setSettings(s.data);
    if (sc.status === 200 && sc.data) setSchedules(sc.data);
    if (s.status !== 200 || sc.status !== 200) setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call<Settings>('/admin/exit/settings', {
      method: 'PUT',
      body: {
        preBajaAvisoDias: Number(f.get('preBajaAvisoDias')),
        zipExpiryDays: Number(f.get('zipExpiryDays')),
      },
    });
    if (res.status === 200) {
      setOk('Configuración guardada.');
      await load();
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError('Revise los valores: días entre 0 y 90.');
  }

  async function schedule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call<Schedule>('/admin/exit/schedule', {
      method: 'POST',
      body: {
        nIde: String(f.get('nIde') ?? '').trim(),
        plannedDate: String(f.get('plannedDate') ?? ''),
        reason: String(f.get('reason') ?? '').trim(),
      },
    });
    if (res.status === 201) {
      setOk('Baja programada.');
      e.currentTarget.reset();
      await load();
    } else if (res.status === 400) {
      const code = (res.data as { code?: string } | null)?.code;
      setError(
        code === 'ALREADY_ACTIVE'
          ? 'Ese empleado ya tiene una baja programada o avisada.'
          : code === 'EMPLOYEE_NOT_ACTIVE'
            ? 'El empleado no tiene un contrato vigente.'
            : code === 'EMPLOYEE_NOT_FOUND'
              ? 'No se encontró ese N_IDE.'
              : 'Revise los datos: fecha AAAA-MM-DD y motivo de al menos 10 caracteres.',
      );
    } else setError(NETWORK_ERROR);
  }

  async function cancel(s: Schedule) {
    setError(null);
    const reason = window.prompt('Motivo de la cancelación (mínimo 10 caracteres):');
    if (!reason) return;
    const res = await call(`/admin/exit/schedule/${s.id}/cancel`, {
      method: 'POST',
      body: { reason },
    });
    if (res.status === 200) await load();
    else setError('No se pudo cancelar.');
  }

  async function loadExports(nIde: string) {
    const res = await call<ExportRow[]>(`/admin/exit/exports?nIde=${encodeURIComponent(nIde)}`);
    if (res.status === 200 && res.data) setExportsByNIde((m) => ({ ...m, [nIde]: res.data ?? [] }));
  }

  async function requestExport(nIde: string) {
    const reason = window.prompt('Motivo de la exportación (mínimo 10 caracteres):');
    if (!reason) return;
    const res = await call('/admin/exit/exports', { method: 'POST', body: { nIde, reason } });
    if (res.status === 201) await loadExports(nIde);
    else setError('No se pudo solicitar la exportación.');
  }

  async function downloadExport(id: string) {
    setError(null);
    const res = await download(`/admin/exit/exports/${id}/download`);
    if (res.status === 200 && res.blob) {
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'baja.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError('No se pudo descargar la exportación (venció o no está lista).');
  }

  return (
    <>
      <PageHeader title="Bajas y exportación de documentos" />
      <p className="muted">
        Antes de aplicar la baja de un empleado, NOMFLOW le avisa con la anticipación configurada y
        le deja descargar una copia de sus documentos (volantes, certificados y constancias de
        vacaciones) por tiempo limitado.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      <section className="import-panel" aria-label="Plazo de aviso">
        <h2>Plazo de aviso y caducidad del ZIP</h2>
        {settings ? (
          <form onSubmit={saveSettings} noValidate key={JSON.stringify(settings)}>
            <div className="grid-2">
              <Field
                label="Días de aviso previo (calendario)"
                name="preBajaAvisoDias"
                type="number"
                min={0}
                max={90}
                defaultValue={settings.preBajaAvisoDias}
                required
              />
              <Field
                label="Caducidad del ZIP (días)"
                name="zipExpiryDays"
                type="number"
                min={1}
                max={90}
                defaultValue={settings.zipExpiryDays}
                required
              />
            </div>
            <button type="submit">Guardar</button>
          </form>
        ) : (
          <p className="muted">Cargando…</p>
        )}
      </section>

      <section className="import-panel" aria-label="Programar baja">
        <h2>Programar baja</h2>
        <form onSubmit={schedule} noValidate>
          <div className="grid-2">
            <Field label="N_IDE del empleado" name="nIde" required maxLength={30} />
            <Field label="Fecha prevista de baja" name="plannedDate" type="date" required />
          </div>
          <Field label="Motivo" name="reason" required minLength={10} maxLength={500} />
          <button type="submit">Programar</button>
        </form>
      </section>

      <section className="import-panel" aria-label="Bajas programadas">
        <h2>Bajas programadas</h2>
        {schedules === null ? (
          <p className="muted">Cargando…</p>
        ) : schedules.length === 0 ? (
          <p className="muted">No hay bajas programadas.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>N_IDE</th>
                <th>Fecha prevista</th>
                <th>Estado</th>
                <th>Aviso enviado</th>
                <th>Exportación</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.nIde}</td>
                  <td>{s.plannedDate}</td>
                  <td>
                    <Badge kind={BADGE[s.status]}>{s.status}</Badge>
                  </td>
                  <td>{formatDate(s.noticeSentAt)}</td>
                  <td>
                    {exportsByNIde[s.nIde] ? (
                      exportsByNIde[s.nIde]?.length ? (
                        <ul>
                          {exportsByNIde[s.nIde]?.map((x) => (
                            <li key={x.id}>
                              <Badge kind={EXPORT_BADGE[x.status]}>{x.status}</Badge>{' '}
                              {x.status === 'LISTO' || x.status === 'INCOMPLETO' ? (
                                <button type="button" onClick={() => void downloadExport(x.id)}>
                                  Descargar
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="muted">Sin exportaciones</span>
                      )
                    ) : (
                      <button type="button" onClick={() => void loadExports(s.nIde)}>
                        Ver
                      </button>
                    )}
                  </td>
                  <td>
                    <button type="button" onClick={() => void requestExport(s.nIde)}>
                      Exportar ahora
                    </button>
                    {['PENDIENTE', 'AVISADO'].includes(s.status) ? (
                      <button type="button" onClick={() => void cancel(s)}>
                        Cancelar
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
