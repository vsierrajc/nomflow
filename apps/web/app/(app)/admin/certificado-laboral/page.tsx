'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader, SelectField, formatDate } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

type Kind = 'GENERAL' | 'DIRIGIDO';

interface Settings {
  mode: 'GENERAL' | 'DIRIGIDO' | 'AMBOS';
  docCode: string;
  docVersion: string;
  docDate: string;
  city: string;
  footerText: string;
  maxPerDay: number;
  requireDigital: boolean;
}

interface Template {
  id: string;
  kind: Kind;
  version: number;
  title: string;
  bodyTemplate: string;
  status: 'VIGENTE' | 'RETIRADA';
  createdAt: string;
}

interface Config {
  settings: Settings;
  templates: Template[];
  variables: Record<string, string>;
}

const KIND_TITLE: Record<Kind, string> = {
  GENERAL: 'Certificado general (sin destinatario)',
  DIRIGIDO: 'Certificado dirigido (con destinatario)',
};

interface Signer {
  id: string;
  name: string;
  title: string;
  tier: 'PRINCIPAL' | 'RESPALDO';
  active: boolean;
  enrolled: boolean;
  hasImage: boolean;
  hasDigital: boolean;
  digitalOrigin: 'AUTOFIRMADO' | 'CARGADO' | null;
  email: string;
  status: string;
}

interface Candidate {
  nIde: string;
  name: string | null;
  email: string;
  status: string;
}

const SIGNER_ERRORS: Record<string, string> = {
  INVALID_SIGNER: 'Revise los datos: el cargo va de 3 a 100 caracteres.',
  ACCOUNT_NOT_FOUND:
    'No hay una cuenta con esa identificación. Cree primero la cuenta del empleado.',
  ALREADY_SIGNER: 'Esa persona ya está designada como firmante de esta empresa.',
};

/** Personas que firman los certificados: la imagen de la firma la carga cada una desde su cuenta. */
function SignersSection({ cEmp }: { cEmp: string }) {
  const { call } = useAdmin();
  const [signers, setSigners] = useState<Signer[] | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [res, cand] = await Promise.all([
      call<Signer[]>(`/admin/labor-certificates/signers/${encodeURIComponent(cEmp)}`),
      call<Candidate[]>(`/admin/labor-certificates/signers/${encodeURIComponent(cEmp)}/candidates`),
    ]);
    if (res.status === 200 && res.data) setSigners(res.data);
    else setError(NETWORK_ERROR);
    if (cand.status === 200 && cand.data) setCandidates(cand.data);
  }, [call, cEmp]);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(res: { status: number; data?: unknown }) {
    const code = (res.data as { code?: string } | undefined)?.code ?? '';
    if (res.status === 403 && !code) setError('Se canceló la confirmación de identidad.');
    else setError(SIGNER_ERRORS[code] ?? NETWORK_ERROR);
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (!chosen) return setError('Elija a la persona de la lista.');
    const form = e.currentTarget;
    const f = new FormData(form);
    const res = await call(`/admin/labor-certificates/signers/${encodeURIComponent(cEmp)}`, {
      method: 'POST',
      body: {
        nIde: chosen,
        title: String(f.get('title') ?? '').trim(),
        tier: String(f.get('tier') ?? 'PRINCIPAL'),
      },
    });
    if (res.status === 201) {
      setOk('Firmante designado. Debe entrar a «Mi firma de certificados» para cargar su firma.');
      form.reset();
      setChosen('');
      setFilter('');
      await load();
    } else fail(res);
  }

  async function change(id: string, body: object) {
    setError(null);
    setOk(null);
    const res = await call<Signer[]>(
      `/admin/labor-certificates/signers/${encodeURIComponent(cEmp)}/${id}`,
      {
        method: 'PUT',
        body,
      },
    );
    if (res.status === 200 && res.data) setSigners(res.data);
    else fail(res);
  }

  return (
    <section className="import-panel" aria-label="Firmantes">
      <h2>Firmantes del certificado</h2>
      <p className="muted">
        Cada certificado lleva la firma de una persona designada: firman los principales (por
        ejemplo el director financiero o la directora de Gestión Humana) y, si ninguno está
        disponible, el de respaldo (por ejemplo el gerente general). Si hay más de un principal, el
        empleado elige. Una persona solo queda disponible cuando su cuenta está activa, su rol
        vigente y ella misma ha cargado su firma y autorizado su uso.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {signers === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : signers.length === 0 ? (
        <p className="muted">
          Todavía no hay firmantes: los empleados no podrán generar certificados.
        </p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Lista de firmantes">
          <table>
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Cargo que se muestra</th>
                <th scope="col">Nivel</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {signers.map((s) => (
                <tr key={s.id}>
                  <th scope="row">
                    {s.name}
                    <br />
                    <span className="muted">{s.email}</span>
                  </th>
                  <td>{s.title}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {s.tier === 'PRINCIPAL' ? 'Principal' : 'Respaldo'}
                  </td>
                  <td>
                    {!s.active ? (
                      <Badge kind="off">Inactivo</Badge>
                    ) : s.status !== 'ACTIVA' ? (
                      <Badge kind="warn">Cuenta sin activar</Badge>
                    ) : s.enrolled ? (
                      <>
                        {s.hasImage ? <Badge kind="ok">Imagen</Badge> : null}{' '}
                        {s.hasDigital ? (
                          <Badge kind="ok">
                            Digital{s.digitalOrigin === 'AUTOFIRMADO' ? ' (autofirmada)' : ''}
                          </Badge>
                        ) : null}
                      </>
                    ) : (
                      <Badge kind="warn">Falta su firma</Badge>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => void change(s.id, { active: !s.active })}
                    >
                      {s.active ? 'Desactivar' : 'Activar'}
                    </button>
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() =>
                        void change(s.id, {
                          tier: s.tier === 'PRINCIPAL' ? 'RESPALDO' : 'PRINCIPAL',
                        })
                      }
                    >
                      {s.tier === 'PRINCIPAL' ? 'Pasar a respaldo' : 'Pasar a principal'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={add} noValidate>
        <h3>Designar un firmante</h3>
        <div className="grid-2">
          <>
            <Field
              label="Buscar en la lista"
              name="filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              optional
              maxLength={60}
              hint="Escriba parte del nombre, del correo o de la identificación."
            />
            <div className="field">
              <label htmlFor="signer-person">Persona a designar</label>
              <select
                id="signer-person"
                name="person"
                value={chosen}
                onChange={(e) => setChosen(e.target.value)}
                required
              >
                <option value="">- Seleccione una persona -</option>
                {candidates
                  .filter((c) =>
                    `${c.name ?? ''} ${c.email} ${c.nIde}`
                      .toLowerCase()
                      .includes(filter.trim().toLowerCase()),
                  )
                  .map((c) => (
                    <option key={c.nIde} value={c.nIde}>
                      {c.name ?? c.email} ({c.email})
                      {c.status === 'ACTIVA' ? '' : ' - cuenta sin activar'}
                    </option>
                  ))}
              </select>
            </div>
          </>
          <Field
            label="Cargo que aparece bajo la firma"
            name="title"
            required
            maxLength={100}
            hint="Por ejemplo: Directora de Gestión Humana."
          />
          <div className="field">
            <label htmlFor="tier">Nivel</label>
            <select id="tier" name="tier" defaultValue="PRINCIPAL">
              <option value="PRINCIPAL">Principal (firma normalmente)</option>
              <option value="RESPALDO">
                Respaldo (firma si no hay ningún principal disponible)
              </option>
            </select>
          </div>
        </div>
        <button type="submit">Designar firmante</button>
      </form>
    </section>
  );
}

function TemplateEditor({
  cEmp,
  kind,
  templates,
  variables,
  onSaved,
}: {
  cEmp: string;
  kind: Kind;
  templates: Template[];
  variables: Record<string, string>;
  onSaved: () => Promise<void>;
}) {
  const { call, profile } = useAdmin();
  const current = templates.find((t) => t.status === 'VIGENTE');
  const [title, setTitle] = useState(current?.title ?? '');
  const [body, setBody] = useState(current?.bodyTemplate ?? '');
  const [error, setError] = useState<string[] | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    setTitle(current?.title ?? '');
    setBody(current?.bodyTemplate ?? '');
  }, [current?.id, current?.title, current?.bodyTemplate]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const res = await call<{ version: number; details?: string[] }>(
      `/admin/labor-certificates/config/${encodeURIComponent(cEmp)}/templates/${kind}`,
      { method: 'PUT', body: { title, body } },
    );
    if (res.status === 200 && res.data) {
      setOk(`Guardado como versión ${res.data.version}. Se aplica a los próximos certificados.`);
      await onSaved();
    } else if (res.status === 422) setError(res.data?.details ?? ['La plantilla no es válida.']);
    else if (res.status === 403) setError(['Se canceló la confirmación de identidad.']);
    else setError([NETWORK_ERROR]);
  }

  async function preview() {
    setError(null);
    const res = await fetch(
      `/api/admin/labor-certificates/config/${encodeURIComponent(cEmp)}/templates/${kind}/preview`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ title, body }),
      },
    ).catch(() => null);
    if (res?.ok) {
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else if (res?.status === 422) {
      const d = (await res.json().catch(() => ({}))) as { details?: string[] };
      setError(d.details ?? ['La plantilla no es válida.']);
    } else setError([NETWORK_ERROR]);
  }

  const history = templates.filter((t) => t.status === 'RETIRADA');
  return (
    <section className="import-panel" aria-label={KIND_TITLE[kind]}>
      <h2>{KIND_TITLE[kind]}</h2>
      <p className="muted">
        Versión vigente: {current ? current.version : '-'}. Guardar crea una versión nueva; lo ya
        emitido no cambia.
      </p>
      {error ? (
        <ul className="alert alert-error" aria-label="Errores de la plantilla">
          {error.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      <form onSubmit={save} noValidate>
        <Field
          label="Título del documento"
          name={`title-${kind}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          required
        />
        <div className="field">
          <label htmlFor={`body-${kind}`}>Texto del certificado</label>
          <textarea
            id={`body-${kind}`}
            name={`body-${kind}`}
            rows={10}
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
            aria-describedby={`vars-${kind}`}
          />
          <p className="hint" id={`vars-${kind}`}>
            Separe los párrafos con una línea en blanco. Una línea en mayúsculas de hasta 60
            caracteres se muestra como subtítulo centrado. Variables disponibles:{' '}
            {Object.keys(variables)
              .filter((v) => (kind === 'GENERAL' ? v !== 'DESTINATARIO' : true))
              .map((v) => `{{${v}}}`)
              .join(' ')}
          </p>
        </div>
        <div className="toolbar">
          <button type="submit">Guardar nueva versión</button>
          <button type="button" className="secondary" onClick={() => void preview()}>
            Vista previa (datos ficticios)
          </button>
        </div>
      </form>
      {history.length > 0 ? (
        <details>
          <summary>Versiones anteriores ({history.length})</summary>
          <ul>
            {history.map((t) => (
              <li key={t.id}>
                Versión {t.version} - {formatDate(t.createdAt)}{' '}
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => {
                    setTitle(t.title);
                    setBody(t.bodyTemplate);
                  }}
                >
                  Cargar en el editor
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export default function LaborCertificateAdminPage() {
  const { call } = useAdmin();
  const [companies, setCompanies] = useState<{ value: string; label: string }[]>([]);
  const [cEmp, setCEmp] = useState('');
  const [cfg, setCfg] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res =
        await call<{ cEmp: string; nombre: string; active: boolean }[]>('/admin/companies');
      if (res.status !== 200 || !res.data) return setError(NETWORK_ERROR);
      const list = res.data
        .filter((c) => c.active)
        .map((c) => ({ value: c.cEmp, label: `${c.cEmp} - ${c.nombre}` }));
      setCompanies(list);
      setCEmp((cur) => cur || list[0]?.value || '');
    })();
  }, [call]);

  const load = useCallback(async () => {
    if (!cEmp) return;
    const res = await call<Config>(`/admin/labor-certificates/config/${encodeURIComponent(cEmp)}`);
    if (res.status === 200 && res.data) setCfg(res.data);
    else setError(NETWORK_ERROR);
  }, [call, cEmp]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    const res = await call<Settings>(
      `/admin/labor-certificates/config/${encodeURIComponent(cEmp)}/settings`,
      {
        method: 'PUT',
        body: {
          mode: v('mode'),
          docCode: v('docCode'),
          docVersion: v('docVersion'),
          docDate: v('docDate'),
          city: v('city'),
          footerText: String(f.get('footerText') ?? '').trim(),
          maxPerDay: Number(f.get('maxPerDay')),
          requireDigital: f.get('requireDigital') === 'on',
        },
      },
    );
    if (res.status === 200) {
      setOk('Parámetros guardados.');
      await load();
    } else if (res.status === 400)
      setError(
        'Revise los parámetros: el código, la versión y la ciudad son obligatorios; el pie admite hasta 4 líneas y el máximo diario va de 1 a 100.',
      );
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  const s = cfg?.settings;
  return (
    <>
      <PageHeader title="Certificado laboral" />
      <p className="muted">
        El empleado genera su certificado con los datos de su contrato vigente. Aquí se define qué
        modalidad se le ofrece, los datos de control del formato (sistema de gestión de la calidad),
        el pie de página con los datos de la empresa y el texto del certificado, que se guarda en
        una tabla y se puede modificar cuando la empresa lo requiera. El encabezado lleva el logo y
        el nombre de la empresa, que se administran en «Empresas y logo».
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {companies.length > 1 ? (
        <SelectField
          label="Empresa"
          name="cEmp"
          value={cEmp}
          onChange={setCEmp}
          options={companies}
        />
      ) : null}

      {!cfg || !s ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <>
          <section className="import-panel" aria-label="Parámetros del certificado">
            <h2>Parámetros</h2>
            <form onSubmit={saveSettings} noValidate key={JSON.stringify(s)}>
              <SelectFieldUncontrolled
                label="Modalidad que se ofrece al empleado"
                name="mode"
                defaultValue={s.mode}
                options={[
                  { value: 'AMBOS', label: 'El empleado elige: general o dirigido' },
                  { value: 'GENERAL', label: 'Solo general (sin destinatario)' },
                  { value: 'DIRIGIDO', label: 'Solo dirigido (con destinatario)' },
                ]}
              />
              <div className="grid-2">
                <Field
                  label="Código del documento"
                  name="docCode"
                  defaultValue={s.docCode}
                  required
                  maxLength={40}
                  hint="Código del formato en el sistema de gestión de la calidad. Ejemplo: GH-FO-012."
                />
                <Field
                  label="Versión del formato"
                  name="docVersion"
                  defaultValue={s.docVersion}
                  required
                  maxLength={20}
                />
                <Field
                  label="Fecha del formato"
                  name="docDate"
                  defaultValue={s.docDate}
                  optional
                  maxLength={40}
                  hint="Fecha de vigencia del formato, como se registra en calidad. Ejemplo: 15 de enero de 2026."
                />
                <Field
                  label="Ciudad de emisión"
                  name="city"
                  defaultValue={s.city}
                  required
                  maxLength={80}
                />
                <Field
                  label="Máximo de certificados por empleado al día"
                  name="maxPerDay"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={s.maxPerDay}
                  required
                />
              </div>
              <label className="choice">
                <input type="checkbox" name="requireDigital" defaultChecked={s.requireDigital} />
                <span>
                  Exigir firma digital criptográfica: solo firman quienes tengan un certificado
                  digital vigente (recomendado en producción con certificados de una entidad de
                  certificación).
                </span>
              </label>
              <div className="field">
                <label htmlFor="footerText">Datos de la empresa para el pie de página</label>
                <textarea
                  id="footerText"
                  name="footerText"
                  rows={4}
                  defaultValue={s.footerText}
                  maxLength={500}
                  aria-describedby="footer-hint"
                />
                <p className="hint" id="footer-hint">
                  Una línea por renglón, hasta 4 (NIT, teléfonos, correo, sitio web). La dirección
                  de la empresa se agrega sola.
                </p>
              </div>
              <button type="submit">Guardar parámetros</button>
            </form>
          </section>
          <SignersSection cEmp={cEmp} />
          {(['GENERAL', 'DIRIGIDO'] as const).map((k) => (
            <TemplateEditor
              key={k}
              cEmp={cEmp}
              kind={k}
              templates={cfg.templates.filter((t) => t.kind === k)}
              variables={cfg.variables}
              onSaved={load}
            />
          ))}
          <p className="muted">
            <Badge kind="ok">Nota</Badge> Si en el texto usa {'{{S_ACT}}'} el certificado mostrará
            el salario actual del empleado: úselo solo si la política de la empresa lo permite.
          </p>
        </>
      )}
    </>
  );
}

/** Lista simple no controlada (el formulario lee el valor al enviar). */
function SelectFieldUncontrolled({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <select id={name} name={name} defaultValue={defaultValue}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
