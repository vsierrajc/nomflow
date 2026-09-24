'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import { permitError } from '@/lib/permits';

interface PermitTypeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  supportRequired: boolean;
  allowsHours: boolean;
  maxDays: number | null;
  active: boolean;
  version: number;
}

export default function PermitTypesPage() {
  const { call } = useAdmin();
  const [items, setItems] = useState<PermitTypeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<PermitTypeRow | null>(null);

  const load = useCallback(async () => {
    const res = await call<PermitTypeRow[]>('/admin/permit-types');
    if (res.status === 200 && res.data) setItems(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const body = (f: FormData) => ({
    name: String(f.get('name') ?? ''),
    description: String(f.get('description') ?? '') || null,
    supportRequired: f.get('supportRequired') === 'on',
    allowsHours: f.get('allowsHours') === 'on',
    maxDays: f.get('maxDays') ? Number(f.get('maxDays')) : null,
    active: f.get('active') === 'on',
  });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const res = editing
      ? await call(`/admin/permit-types/${editing.id}`, {
          method: 'PUT',
          body: { ...body(f), version: editing.version },
        })
      : await call('/admin/permit-types', {
          method: 'POST',
          body: { ...body(f), code: String(f.get('code') ?? '').toUpperCase() },
        });
    if (res.status === 200 || res.status === 201) {
      setOk(editing ? 'Tipo actualizado.' : 'Tipo creado.');
      setEditing(null);
      form.reset();
      await load();
    } else setError(permitError(res.status, res.data));
  }

  return (
    <>
      <PageHeader title="Tipos de permiso" />
      <p className="muted">
        Los permisos solo los decide el jefe de área y no descuentan vacaciones. Aquí se define qué
        tipos existen y sus reglas. Un tipo inactivo deja de ofrecerse, pero las solicitudes ya
        enviadas se conservan.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      <section className="import-panel" aria-label={editing ? 'Editar tipo' : 'Nuevo tipo'}>
        <h2>{editing ? `Editar «${editing.name}»` : 'Nuevo tipo de permiso'}</h2>
        <form onSubmit={save} noValidate key={editing?.id ?? 'nuevo'}>
          <div className="grid-2">
            {editing ? null : (
              <Field
                label="Código (mayúsculas, números y _)"
                name="code"
                required
                maxLength={30}
                hint="No se puede cambiar después."
              />
            )}
            <Field
              label="Nombre"
              name="name"
              required
              maxLength={100}
              defaultValue={editing?.name ?? ''}
            />
            <Field
              label="Máximo de días por solicitud"
              name="maxDays"
              type="number"
              min={1}
              max={365}
              optional
              defaultValue={editing?.maxDays ?? ''}
            />
          </div>
          <Field
            label="Descripción"
            name="description"
            optional
            maxLength={300}
            defaultValue={editing?.description ?? ''}
          />
          <label className="choice">
            <input
              type="checkbox"
              name="supportRequired"
              defaultChecked={editing?.supportRequired ?? false}
            />
            <span>Exige adjuntar un soporte</span>
          </label>
          <label className="choice">
            <input
              type="checkbox"
              name="allowsHours"
              defaultChecked={editing?.allowsHours ?? false}
            />
            <span>Permite indicar horas (permiso de un solo día)</span>
          </label>
          <label className="choice">
            <input type="checkbox" name="active" defaultChecked={editing?.active ?? true} />
            <span>Activo (se ofrece a los empleados)</span>
          </label>
          <button type="submit">{editing ? 'Guardar cambios' : 'Crear tipo'}</button>{' '}
          {editing ? (
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </button>
          ) : null}
        </form>
      </section>

      {items === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Tipos de permiso">
          <table>
            <caption className="muted">Tipos de permiso</caption>
            <thead>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Nombre</th>
                <th scope="col">Máx. días</th>
                <th scope="col">Soporte</th>
                <th scope="col">Horas</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.code}</td>
                  <td>{t.name}</td>
                  <td className="num">{t.maxDays ?? '—'}</td>
                  <td>{t.supportRequired ? 'Obligatorio' : 'Opcional'}</td>
                  <td>{t.allowsHours ? 'Sí' : 'No'}</td>
                  <td>
                    <Badge kind={t.active ? 'ok' : 'off'}>{t.active ? 'Activo' : 'Inactivo'}</Badge>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setEditing(t)}
                      aria-label={`Editar el tipo ${t.name}`}
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    Todavía no hay tipos de permiso. Cree el primero arriba.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
