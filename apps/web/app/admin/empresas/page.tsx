'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Modal,
  Notice,
  PageHeader,
  SelectField,
  formatDate,
} from '../../../components/admin-ui';
import { Field } from '../../../components/ui';
import { NETWORK_ERROR } from '../../../lib/api';
import { useAdmin } from '../../../lib/admin';

interface Company {
  id: string;
  cEmp: string;
  nombre: string;
  sigla: string;
  direccion: string;
  active: boolean;
  payrollDefaultMode: 'SIN_AJUSTE' | 'ENTERO_SUPERIOR';
  version: number;
}

interface LogoVersion {
  id: string;
  version: number;
  contentType: string;
  width: number;
  height: number;
  active: boolean;
  uploadedAt: string;
}

const MODES = [
  { value: 'ENTERO_SUPERIOR', label: 'Entero superior' },
  { value: 'SIN_AJUSTE', label: 'Sin ajuste (importes originales)' },
];

const LOGO_ERRORS: Record<string, string> = {
  TOO_LARGE: 'El archivo supera los 512 KB.',
  INVALID_IMAGE: 'El archivo no es una imagen PNG o JPEG válida.',
  INVALID_DIMENSIONS: 'La imagen debe medir entre 64 y 2000 píxeles por lado.',
};

function CompanyForm({
  company,
  onDone,
  onClose,
}: {
  company: Company | null;
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const { call } = useAdmin();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<string>(company?.payrollDefaultMode ?? 'ENTERO_SUPERIOR');
  const [active, setActive] = useState(company?.active ?? true);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const base = {
      nombre: String(f.get('nombre') ?? ''),
      sigla: String(f.get('sigla') ?? ''),
      direccion: String(f.get('direccion') ?? ''),
      payrollDefaultMode: mode,
    };
    setBusy(true);
    setError(null);
    const res = company
      ? await call(`/admin/companies/${company.id}`, {
          method: 'PUT',
          body: { ...base, active, version: company.version },
        })
      : await call('/admin/companies', {
          method: 'POST',
          body: { cEmp: String(f.get('cEmp') ?? ''), ...base },
        });
    setBusy(false);
    if (res.status === 200 || res.status === 201)
      onDone(company ? 'Empresa actualizada.' : 'Empresa creada.');
    else if (res.status === 409)
      setError(
        company
          ? 'Otra persona modificó esta empresa. Cierre y vuelva a abrirla.'
          : 'Ya existe una empresa con ese código.',
      );
    else if (res.status === 400) setError('Revise los datos: todos los campos son obligatorios.');
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <Modal title={company ? `Editar empresa ${company.cEmp}` : 'Nueva empresa'} onClose={onClose}>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form onSubmit={onSubmit} noValidate>
        {company ? null : (
          <Field label="Código de la empresa" name="cEmp" required maxLength={30} />
        )}
        <Field
          label="Nombre legal"
          name="nombre"
          defaultValue={company?.nombre}
          required
          maxLength={200}
        />
        <Field label="Sigla" name="sigla" defaultValue={company?.sigla} required maxLength={30} />
        <Field
          label="Dirección"
          name="direccion"
          defaultValue={company?.direccion}
          required
          maxLength={300}
        />
        <SelectField
          label="Modo de presentación sugerido del volante"
          name="mode"
          value={mode}
          onChange={setMode}
          options={MODES}
        />
        {company ? (
          <label className="choice">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
            Empresa activa
          </label>
        ) : null}
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LogoDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const { call, send } = useAdmin();
  const [versions, setVersions] = useState<LogoVersion[]>([]);
  const [stamp, setStamp] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadVersions = useCallback(async () => {
    const res = await call<LogoVersion[]>(`/admin/companies/${company.id}/logos`);
    if (res.status === 200 && res.data) setVersions(res.data);
  }, [call, company.id]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setError('Elija un archivo PNG o JPEG.');
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    const res = await send<{ code?: string }>(`/admin/companies/${company.id}/logo`, form);
    setBusy(false);
    if (res.status === 201) {
      setOk('Logo cargado. Los nuevos volantes ya lo usan.');
      setStamp(Date.now());
      void loadVersions();
      (e.target as HTMLFormElement).reset();
    } else if (res.status === 413) setError(LOGO_ERRORS.TOO_LARGE ?? '');
    else if (res.status === 422)
      setError(LOGO_ERRORS[res.data?.code ?? ''] ?? 'La imagen no es válida.');
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  async function activate(id: string) {
    setError(null);
    setOk(null);
    const res = await call(`/admin/companies/${company.id}/logo/${id}/activate`, {
      method: 'POST',
    });
    if (res.status === 204) {
      setOk('Versión activada.');
      setStamp(Date.now());
      void loadVersions();
    } else setError(NETWORK_ERROR);
  }

  async function reset() {
    setError(null);
    setOk(null);
    const res = await call(`/admin/companies/${company.id}/logo/reset`, { method: 'POST' });
    if (res.status === 204) {
      setOk('Se restableció el logo genérico.');
      setStamp(Date.now());
      void loadVersions();
    } else setError(NETWORK_ERROR);
  }

  return (
    <Modal title={`Logo de ${company.nombre}`} onClose={onClose} wide>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      <div className="grid-2">
        <div>
          <h3>Logo actual</h3>
          <img
            className="logo-preview"
            alt={`Logo actual de ${company.nombre}`}
            src={`/api/admin/companies/${company.id}/logo?v=${stamp}`}
          />
          <p className="muted">Se usa en el encabezado de los volantes de pago.</p>
        </div>
        <form onSubmit={onUpload}>
          <h3>Cargar un logo nuevo</h3>
          <div className="field">
            <label htmlFor="logo-file">Archivo PNG o JPEG</label>
            <input id="logo-file" name="file" type="file" accept="image/png,image/jpeg" />
            <p className="hint">Máximo 512 KB; entre 64 y 2000 píxeles por lado.</p>
          </div>
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? 'Cargando…' : 'Cargar logo'}
            </button>
            <button type="button" className="secondary" onClick={() => void reset()}>
              Volver al logo genérico
            </button>
          </div>
        </form>
      </div>
      <h3>Versiones cargadas</h3>
      {versions.length === 0 ? (
        <p className="muted">Todavía no se ha cargado ningún logo: se usa el genérico.</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabla de datos">
          <table>
            <thead>
              <tr>
                <th scope="col">Versión</th>
                <th scope="col">Formato</th>
                <th scope="col">Tamaño</th>
                <th scope="col">Fecha</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>{v.version}</td>
                  <td>{v.contentType.replace('image/', '').toUpperCase()}</td>
                  <td>
                    {v.width} x {v.height}
                  </td>
                  <td>{formatDate(v.uploadedAt)}</td>
                  <td>
                    {v.active ? (
                      <Badge kind="ok">En uso</Badge>
                    ) : (
                      <Badge kind="off">Anterior</Badge>
                    )}
                  </td>
                  <td>
                    {v.active ? null : (
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => void activate(v.id)}
                      >
                        Usar esta versión
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export default function CompaniesPage() {
  const { call } = useAdmin();
  const [items, setItems] = useState<Company[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Company | 'new' | null>(null);
  const [logoOf, setLogoOf] = useState<Company | null>(null);

  const load = useCallback(async () => {
    const res = await call<Company[]>('/admin/companies');
    if (res.status === 200 && res.data) {
      setItems(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title="Empresas y logo">
        <button type="button" onClick={() => setEditing('new')}>
          Nueva empresa
        </button>
      </PageHeader>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {items === null ? (
        <p className="muted">Cargando…</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Empresas registradas">
          <table>
            <caption className="muted">Empresas registradas</caption>
            <thead>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Nombre</th>
                <th scope="col">Sigla</th>
                <th scope="col">Dirección</th>
                <th scope="col">Modo del volante</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{c.cEmp}</td>
                  <td>{c.nombre}</td>
                  <td>{c.sigla}</td>
                  <td>{c.direccion}</td>
                  <td>
                    {c.payrollDefaultMode === 'ENTERO_SUPERIOR' ? 'Entero superior' : 'Sin ajuste'}
                  </td>
                  <td>
                    {c.active ? (
                      <Badge kind="ok">Activa</Badge>
                    ) : (
                      <Badge kind="off">Inactiva</Badge>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => setEditing(c)}
                        aria-label={`Editar ${c.nombre}`}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => setLogoOf(c)}
                        aria-label={`Logo de ${c.nombre}`}
                      >
                        Logo
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    Aún no hay empresas. Cree la primera para poder importar catálogos.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      {editing ? (
        <CompanyForm
          company={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            setNotice(msg);
            void load();
          }}
        />
      ) : null}
      {logoOf ? <LogoDialog company={logoOf} onClose={() => setLogoOf(null)} /> : null}
    </>
  );
}
