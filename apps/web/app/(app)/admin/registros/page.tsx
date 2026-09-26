'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, SelectField, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Summary {
  audit: {
    total: number;
    http: number;
    events: number;
    oldest: string | null;
    newest: string | null;
    tableBytes: number;
    months: { month: string; n: number }[];
  };
  files: { name: string; size: number; modified: string | null }[];
  settings: {
    retentionDays: number;
    httpRetentionDays: number;
    archiveBeforePurge: boolean;
    autoEnabled: boolean;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunSummary: string | null;
  };
  archives: Archive[];
  coldConfigured: boolean;
}

interface Archive {
  id: string;
  source: string;
  kind: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  rowCount: number;
  sizeBytes: number;
  purgedCount: number;
  createdAt: string;
}

const KINDS = [
  { value: 'TODO', label: 'Todo (peticiones y eventos)' },
  { value: 'HTTP', label: 'Solo peticiones HTTP' },
  { value: 'EVENTOS', label: 'Solo eventos de auditoría' },
];

const ERRORS: Record<string, string> = {
  INVALID: 'Revise los datos: fechas válidas y los valores dentro de los rangos permitidos.',
  CONFIRM_REQUIRED: 'Escriba BORRAR para confirmar y un motivo de al menos 10 caracteres.',
  COLD_NOT_CONFIGURED:
    'Aún no hay un bucket en la nube configurado: configúrelo en «Archivo histórico».',
  NO_KEY: 'Falta OBJECT_ENCRYPTION_KEY en el servidor: sin ella no se pueden cifrar las copias.',
  ARCHIVE_FAILED: 'No se pudo copiar o verificar la copia en la nube. No se borró nada.',
  TOO_LARGE: 'El archivo es demasiado grande para enviarlo (máximo 100 MB).',
  NOT_FOUND: 'No se encontró el registro.',
};

const kb = (b: number) =>
  b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const num = (n: number) => n.toLocaleString('es-CO');
const today = () => new Date().toISOString().slice(0, 10);

export default function LogsPage() {
  const { call } = useAdmin();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // exportar / enviar
  const [kind, setKind] = useState('TODO');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState('csv');
  // depurar
  const [pKind, setPKind] = useState('HTTP');
  const [archiveFirst, setArchiveFirst] = useState(true);
  // archivos
  const [file, setFile] = useState('');
  const [lines, setLines] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [truncating, setTruncating] = useState(false);

  const load = useCallback(async () => {
    const res = await call<Summary>('/admin/logs');
    if (res.status === 200 && res.data) {
      setData(res.data);
      setFile((cur) => cur || res.data?.files[0]?.name || '');
    } else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    const d = res.data as { code?: string; detail?: string } | undefined;
    if (res.status === 403 && !d?.code) setError('Se canceló la confirmación de identidad.');
    else setError(`${ERRORS[d?.code ?? ''] ?? NETWORK_ERROR}${d?.detail ? ` (${d.detail})` : ''}`);
  }

  async function act(path: string, body: object, done: (r: never) => string) {
    setError(null);
    setOk(null);
    setBusy(true);
    const res = await call(path, { method: 'POST', body });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setOk(done(res.data as never));
      await load();
      return true;
    }
    fail(res);
    return false;
  }

  const exportUrl = `/api/admin/logs/audit/export?kind=${kind}&format=${format}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`;

  async function archive(e: FormEvent) {
    e.preventDefault();
    await act(
      '/admin/logs/audit/archive',
      { kind, ...(from ? { from } : {}), ...(to ? { to } : {}) },
      (r: { archived: number; archives: number }) =>
        `Se enviaron ${num(r.archived)} registros al histórico en ${r.archives} archivo(s) cifrado(s), verificados.`,
    );
  }

  async function purge(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const good = await act(
      '/admin/logs/audit/purge',
      {
        before: String(f.get('before') ?? ''),
        kind: pKind,
        archive: archiveFirst,
        reason: String(f.get('reason') ?? ''),
        confirm: String(f.get('confirm') ?? ''),
      },
      (r: { deleted: number; archived: number }) =>
        `Depuración terminada: ${num(r.deleted)} registros borrados${r.archived ? ` tras copiar ${num(r.archived)} al histórico` : ' (sin copia)'}. Quedó una huella en la auditoría.`,
    );
    if (good) e.currentTarget.reset();
  }

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call('/admin/logs/settings', {
      method: 'PUT',
      body: {
        retentionDays: Number(f.get('retentionDays')),
        httpRetentionDays: Number(f.get('httpRetentionDays')),
        archiveBeforePurge: f.get('archiveBeforePurge') === 'on',
        autoEnabled: f.get('autoEnabled') === 'on',
      },
    });
    if (res.status === 200) {
      setOk('Política guardada.');
      await load();
    } else fail(res);
  }

  async function runNow() {
    await act(
      '/admin/logs/maintenance/run',
      {},
      (r: { purged: number; archived: number }) =>
        `Mantenimiento hecho: ${num(r.archived)} archivados y ${num(r.purged)} depurados.`,
    );
  }

  async function tail() {
    setError(null);
    const res = await call<{ lines: string[]; size: number }>(
      `/admin/logs/files/${encodeURIComponent(file)}/tail?lines=300${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    );
    if (res.status === 200 && res.data) setLines(res.data.lines);
    else fail(res);
  }

  async function truncate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const good = await act(
      `/admin/logs/files/${encodeURIComponent(file)}/truncate`,
      {
        archiveFirst: f.get('archiveFirst') === 'on',
        reason: String(f.get('reason') ?? ''),
        confirm: String(f.get('confirm') ?? ''),
      },
      (r: { cleared: number }) => `Se vació el archivo (${kb(r.cleared)}).`,
    );
    if (good) {
      setTruncating(false);
      setLines(null);
    }
  }

  const s = data?.settings;
  return (
    <>
      <PageHeader title="Registros y depuración" />
      <p className="muted">
        Controle los registros del sistema: la <strong>auditoría</strong> (base de datos: peticiones
        HTTP y eventos) y los <strong>archivos de registro</strong> de la aplicación. Puede verlos,
        exportarlos, enviarlos cifrados al histórico en la nube (Google), depurarlos e incluso
        vaciarlos. Cada operación queda registrada y las huellas de las depuraciones no se borran.
        Para consultar la auditoría con filtros, use <Link href="/admin/auditoria">Auditoría</Link>.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      {data === null || !s ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <section className="import-panel" aria-label="Resumen de la auditoría">
            <h2>Auditoría en la base de datos</h2>
            <div className="cards">
              <div className="stat">
                <strong>{num(data.audit.total)}</strong>Registros
              </div>
              <div className="stat">
                <strong>{num(data.audit.http)}</strong>Peticiones HTTP
              </div>
              <div className="stat">
                <strong>{num(data.audit.events)}</strong>Eventos de auditoría
              </div>
              <div className="stat">
                <strong>{kb(data.audit.tableBytes)}</strong>Espacio de la tabla
              </div>
            </div>
            <p className="muted">
              Del {data.audit.oldest ? formatDate(data.audit.oldest) : '-'} al{' '}
              {data.audit.newest ? formatDate(data.audit.newest) : '-'}.{' '}
              {data.audit.months.length > 0
                ? `Por mes: ${data.audit.months.map((m) => `${m.month} (${num(m.n)})`).join(', ')}.`
                : ''}
            </p>
            {!data.coldConfigured ? (
              <Notice kind="warn">
                El histórico en la nube no está configurado: no se puede enviar ni archivar antes de
                depurar. Configúrelo en <Link href="/admin/archivo">Archivo histórico</Link>.
              </Notice>
            ) : null}
          </section>

          <section className="import-panel" aria-label="Exportar o enviar al histórico">
            <h2>Exportar o enviar al histórico</h2>
            <form onSubmit={archive} noValidate>
              <div className="grid-2">
                <SelectField
                  label="Qué registros"
                  name="kind"
                  value={kind}
                  onChange={setKind}
                  options={KINDS}
                />
                <SelectField
                  label="Formato de exportación"
                  name="format"
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: 'csv', label: 'CSV (Excel)' },
                    { value: 'jsonl', label: 'JSON Lines' },
                  ]}
                />
                <Field
                  label="Desde (opcional)"
                  name="from"
                  type="date"
                  value={from}
                  max={today()}
                  onChange={(e) => setFrom(e.target.value)}
                  optional
                />
                <Field
                  label="Hasta (opcional)"
                  name="to"
                  type="date"
                  value={to}
                  max={today()}
                  onChange={(e) => setTo(e.target.value)}
                  optional
                />
              </div>
              <div className="toolbar">
                <a className="button secondary" href={exportUrl} download>
                  Descargar exportación
                </a>
                <button type="submit" disabled={busy || !data.coldConfigured}>
                  Enviar al histórico en Google
                </button>
              </div>
              <p className="hint">
                Lo enviado se comprime, se cifra en NOMFLOW y se verifica al releerlo. No se borra
                nada de la base: para liberar espacio use «Depurar».
              </p>
            </form>
          </section>

          <section className="import-panel" aria-label="Depurar la auditoría">
            <h2>Depurar (borrar registros antiguos)</h2>
            <form onSubmit={purge} noValidate>
              <div className="grid-2">
                <Field
                  label="Borrar lo anterior a"
                  name="before"
                  type="date"
                  max={today()}
                  required
                  hint="Se borra todo lo que sea anterior a esta fecha (sin incluirla)."
                />
                <SelectField
                  label="Qué se borra"
                  name="pKind"
                  value={pKind}
                  onChange={setPKind}
                  options={KINDS}
                />
              </div>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={archiveFirst}
                  onChange={(e) => setArchiveFirst(e.target.checked)}
                />
                <span>
                  Copiar al histórico en la nube antes de borrar (recomendado). Solo se borra lo
                  copiado y verificado; si la copia falla no se borra nada.
                </span>
              </label>
              {!archiveFirst ? (
                <Notice kind="warn">
                  Sin copia previa, lo borrado <strong>no se puede recuperar</strong>. Exporte antes
                  si necesita conservarlo.
                </Notice>
              ) : null}
              <Field label="Motivo (mínimo 10 caracteres)" name="reason" required maxLength={300} />
              <Field
                label="Escriba BORRAR para confirmar"
                name="confirm"
                required
                maxLength={10}
                autoComplete="off"
              />
              <button type="submit" className="danger" disabled={busy}>
                Depurar ahora
              </button>
            </form>
          </section>

          <section className="import-panel" aria-label="Política de retención">
            <h2>Política de retención</h2>
            <form onSubmit={saveSettings} noValidate key={JSON.stringify(s)}>
              <div className="grid-2">
                <Field
                  label="Conservar eventos de auditoría (días)"
                  name="retentionDays"
                  type="number"
                  min={30}
                  max={3650}
                  defaultValue={s.retentionDays}
                  required
                  hint="De 30 a 3650 días."
                />
                <Field
                  label="Conservar peticiones HTTP (días)"
                  name="httpRetentionDays"
                  type="number"
                  min={7}
                  max={3650}
                  defaultValue={s.httpRetentionDays}
                  required
                  hint="De 7 a 3650 días. Son las más numerosas."
                />
              </div>
              <label className="choice">
                <input
                  type="checkbox"
                  name="archiveBeforePurge"
                  defaultChecked={s.archiveBeforePurge}
                />
                <span>Copiar al histórico antes de borrar lo vencido</span>
              </label>
              <label className="choice">
                <input type="checkbox" name="autoEnabled" defaultChecked={s.autoEnabled} />
                <span>Aplicar la política automáticamente una vez al día</span>
              </label>
              <div className="toolbar">
                <button type="submit">Guardar política</button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void runNow()}
                >
                  Aplicar ahora
                </button>
              </div>
              <p className="muted">
                {s.lastRunAt
                  ? `Última aplicación: ${formatDate(s.lastRunAt)} (${s.lastRunStatus === 'OK' ? 'correcta' : 'con error'}). ${s.lastRunSummary ?? ''}`
                  : 'Aún no se ha aplicado.'}
              </p>
            </form>
          </section>

          <section className="import-panel" aria-label="Archivos de registro de la aplicación">
            <h2>Archivos de registro de la aplicación</h2>
            {data.files.length === 0 ? (
              <p className="muted">
                No hay archivos configurados. Se indican con la variable LOG_FILES (nombre=ruta,
                separados por coma); el script de inicio ya la define.
              </p>
            ) : (
              <>
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label="Archivos configurados"
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Archivo</th>
                        <th scope="col">Tamaño</th>
                        <th scope="col">Modificado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.files.map((f) => (
                        <tr key={f.name}>
                          <th scope="row">{f.name}</th>
                          <td>{kb(f.size)}</td>
                          <td>{f.modified ? formatDate(f.modified) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid-2">
                  <SelectField
                    label="Archivo"
                    name="file"
                    value={file}
                    onChange={(v) => {
                      setFile(v);
                      setLines(null);
                    }}
                    options={data.files.map((f) => ({ value: f.name, label: f.name }))}
                  />
                  <Field
                    label="Filtrar líneas que contengan (opcional)"
                    name="q"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    optional
                    maxLength={100}
                  />
                </div>
                <div className="toolbar">
                  <button type="button" onClick={() => void tail()}>
                    Ver últimas líneas
                  </button>
                  <a
                    className="button secondary"
                    href={`/api/admin/logs/files/${encodeURIComponent(file)}/download`}
                    download
                  >
                    Descargar
                  </a>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !data.coldConfigured}
                    onClick={() =>
                      void act(
                        `/admin/logs/files/${encodeURIComponent(file)}/archive`,
                        {},
                        (r: { bytes: number }) =>
                          `Se envió al histórico (${kb(r.bytes)}), cifrado y verificado.`,
                      )
                    }
                  >
                    Enviar al histórico
                  </button>
                  <button type="button" className="danger" onClick={() => setTruncating(true)}>
                    Vaciar…
                  </button>
                </div>
                {truncating ? (
                  <form onSubmit={truncate} noValidate aria-label="Vaciar el archivo">
                    <Notice kind="warn">
                      Se vaciará el contenido de «{file}»: no se puede deshacer. La aplicación sigue
                      escribiendo en él.
                    </Notice>
                    <label className="choice">
                      <input
                        type="checkbox"
                        name="archiveFirst"
                        defaultChecked={data.coldConfigured}
                        disabled={!data.coldConfigured}
                      />
                      <span>Enviar una copia al histórico antes de vaciar</span>
                    </label>
                    <Field
                      label="Motivo (mínimo 10 caracteres)"
                      name="reason"
                      required
                      maxLength={300}
                    />
                    <Field
                      label="Escriba BORRAR para confirmar"
                      name="confirm"
                      required
                      maxLength={10}
                      autoComplete="off"
                    />
                    <div className="toolbar">
                      <button type="submit" className="danger" disabled={busy}>
                        Vaciar el archivo
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setTruncating(false)}
                      >
                        Cancelar
                      </button>
                    </div>
                  </form>
                ) : null}
                {lines !== null ? (
                  <pre className="log-view" tabIndex={0} aria-label={`Últimas líneas de ${file}`}>
                    {lines.length === 0 ? '(sin líneas)' : lines.join('\n')}
                  </pre>
                ) : null}
              </>
            )}
          </section>

          <section className="import-panel" aria-label="Copias en el histórico">
            <h2>Copias en el histórico en la nube</h2>
            {data.archives.length === 0 ? (
              <p className="muted">Todavía no se ha enviado nada.</p>
            ) : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Lista de copias">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Fecha</th>
                      <th scope="col">Origen</th>
                      <th scope="col">Período</th>
                      <th scope="col">Registros</th>
                      <th scope="col">Tamaño</th>
                      <th scope="col">Borrados</th>
                      <th scope="col">Descargar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.archives.map((a) => (
                      <tr key={a.id}>
                        <td>{formatDate(a.createdAt)}</td>
                        <td>
                          {a.source} {a.kind ? <Badge kind="ok">{a.kind}</Badge> : null}
                        </td>
                        <td>
                          {a.periodFrom ? formatDate(a.periodFrom) : '-'} →{' '}
                          {a.periodTo ? formatDate(a.periodTo) : '-'}
                        </td>
                        <td>{a.rowCount ? num(a.rowCount) : '-'}</td>
                        <td>{kb(a.sizeBytes)}</td>
                        <td>{num(a.purgedCount)}</td>
                        <td>
                          <a
                            className="button secondary small"
                            href={`/api/admin/logs/archives/${a.id}/download`}
                            download
                          >
                            Descargar
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
