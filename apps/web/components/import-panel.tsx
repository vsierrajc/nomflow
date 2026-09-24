'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import { Field } from '@/components/ui';
import { Notice } from '@/components/admin-ui';

export interface ExtraField {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  pattern?: string;
  maxLength?: number;
  defaultValue?: string;
}

interface Batch {
  id: string;
  type: string;
  status: 'LISTO' | 'OBSERVADO' | 'APLICADO' | 'FALLIDO' | string;
  rowCount: number;
  errorCount: number;
  stats: Record<string, unknown>;
}

interface Issue {
  row: number;
  column: string;
  value: string | null;
  rule: string;
}

const STAT_LABELS: Record<string, string> = {
  sheet: 'Hoja leída',
  created: 'Registros nuevos',
  changed: 'Registros modificados',
  renamed: 'Nombres modificados',
  unchanged: 'Sin cambios',
  missingInFile: 'Existentes que no vienen en el archivo',
  warnings: 'Advertencias',
  people: 'Personas',
  active: 'Vigentes',
  cancelled: 'Cancelados',
  toCancel: 'Pasan a cancelado',
  vouchers: 'Volantes',
  totalDev: 'Total devengado',
  totalDed: 'Total deducido',
  net: 'Neto',
  unknownConcepts: 'Conceptos sin catálogo',
  withoutEmployee: 'Personas sin registro de empleado',
  per: 'Período',
  nLiq: 'Liquidación',
  cEmp: 'Empresa',
  units: 'Unidades',
};

const HIDDEN_STATS = new Set(['contentHash', 'replaces']);

const STATUS_TEXT: Record<string, string> = {
  LISTO: 'Lista para aplicar',
  OBSERVADO: 'Con observaciones: corrija el archivo y vuelva a cargarlo',
  APLICADO: 'Aplicada',
  FALLIDO: 'Falló y no se aplicó',
};

function statValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (v !== null && typeof v === 'object') return '';
  return String(v);
}

export function ImportPanel({
  title,
  endpoint,
  extraFields = [],
  defaultResponsible,
  onApplied,
  children,
}: {
  title: string;
  endpoint: string;
  extraFields?: ExtraField[];
  defaultResponsible?: string;
  onApplied?: () => void;
  children?: ReactNode;
}) {
  const { call, send } = useAdmin();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('Elija el archivo Excel (.xlsx) que va a cargar.');
      return;
    }
    for (const [key, value] of Array.from(form.entries())) {
      if (typeof value === 'string' && value.trim() === '') form.delete(key);
    }
    setBusy(true);
    setError(null);
    setOk(null);
    setBatch(null);
    setIssues([]);
    const res = await send<Batch & { code?: string }>(endpoint, form);
    setBusy(false);
    if (res.status === 201 && res.data) {
      setBatch(res.data);
      if (res.data.errorCount > 0) {
        const errs = await call<{ errors: Issue[] }>(`/admin/imports/${res.data.id}/errors`);
        if (errs.status === 200 && errs.data) setIssues(errs.data.errors);
      }
    } else if (res.status === 409) {
      setError(
        res.data?.code === 'SAME_CONTENT'
          ? 'Ese contenido ya está publicado: no hay nada nuevo que aplicar.'
          : 'Ese mismo archivo ya fue aplicado antes. Cargue uno distinto.',
      );
    } else if (res.status === 400)
      setError('El archivo no es un Excel (.xlsx) válido o faltan datos obligatorios.');
    else if (res.status === 422)
      setError('Los datos indicados no son válidos (por ejemplo, la empresa no existe).');
    else if (res.status === 413) setError('El archivo es demasiado grande.');
    else if (res.status === 403)
      setError('Se canceló la confirmación de identidad o no tiene permiso.');
    else setError(NETWORK_ERROR);
  }

  async function apply() {
    if (!batch) return;
    setBusy(true);
    setError(null);
    const res = await call<Batch>(`/admin/imports/${batch.id}/apply`, { method: 'POST' });
    setBusy(false);
    if (res.status === 200 && res.data) {
      setBatch(res.data);
      setOk('Importación aplicada correctamente.');
      onApplied?.();
    } else if (res.status === 409)
      setError(
        'Esta importación ya no se puede aplicar (cambió el estado o el contenido ya está publicado).',
      );
    else if (res.status === 422)
      setError(
        'No se aplicó: los datos cambiaron desde la vista previa. Cargue el archivo de nuevo.',
      );
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <section aria-label={title} className="import-panel">
      <h2>{title}</h2>
      {children}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      <form onSubmit={onUpload} noValidate>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={`${endpoint}-file`}>Archivo Excel (.xlsx)</label>
            <input id={`${endpoint}-file`} name="file" type="file" accept=".xlsx" />
          </div>
          <Field
            label="Sistema de origen"
            name="sourceSystem"
            defaultValue="ERP"
            required
            maxLength={100}
          />
          <Field
            label="Responsable de la carga"
            name="responsible"
            defaultValue={defaultResponsible ?? ''}
            required
            maxLength={150}
          />
          <Field
            label="Hoja (opcional)"
            name="sheet"
            hint="Déjela vacía para usar la primera hoja."
            maxLength={100}
          />
          {extraFields.map((f) => (
            <Field
              key={f.name}
              label={f.label}
              name={f.name}
              hint={f.hint}
              required={f.required}
              pattern={f.pattern}
              maxLength={f.maxLength}
              defaultValue={f.defaultValue}
            />
          ))}
        </div>
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy && !batch ? 'Validando…' : 'Validar archivo'}
          </button>
        </div>
      </form>

      {batch ? (
        <div className="import-result" aria-live="polite">
          <h3>Resultado de la validación</h3>
          <p>
            <strong>{STATUS_TEXT[batch.status] ?? batch.status}</strong> - {batch.rowCount} filas
            válidas
            {batch.errorCount > 0 ? `, ${batch.errorCount} con errores` : ''}.
          </p>
          <dl className="stats">
            {Object.entries(batch.stats)
              .filter(([k, v]) => !HIDDEN_STATS.has(k) && statValue(v) !== '')
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{STAT_LABELS[k] ?? k}</dt>
                  <dd>{statValue(v)}</dd>
                </div>
              ))}
          </dl>
          {batch.status === 'LISTO' ? (
            <div className="actions">
              <button type="button" onClick={() => void apply()} disabled={busy}>
                {busy ? 'Aplicando…' : 'Aplicar importación'}
              </button>
              <span className="muted">Solo se publica lo que ve en esta vista previa.</span>
            </div>
          ) : null}
          {issues.length > 0 ? (
            <>
              <h3>Errores por corregir en el archivo</h3>
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Se muestran hasta 1000 errores; por privacidad no se repiten valores s"
              >
                <table>
                  <caption className="muted caption-note">
                    Se muestran hasta 1000 errores; por privacidad no se repiten valores sensibles.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Fila</th>
                      <th scope="col">Columna</th>
                      <th scope="col">Regla incumplida</th>
                      <th scope="col">Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issues.slice(0, 200).map((i, n) => (
                      <tr key={`${i.row}-${i.column}-${n}`}>
                        <td>{i.row || '-'}</td>
                        <td>{i.column || '-'}</td>
                        <td>{i.rule}</td>
                        <td>{i.value ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {issues.length > 200 ? (
                <p className="muted">Mostrando 200 de {issues.length} errores.</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
