'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader } from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface ShiftRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  active: boolean;
  version: number;
}

const DAYS: { name: keyof ShiftRow; label: string; short: string }[] = [
  { name: 'monday', label: 'Lunes', short: 'Lu' },
  { name: 'tuesday', label: 'Martes', short: 'Ma' },
  { name: 'wednesday', label: 'Miércoles', short: 'Mi' },
  { name: 'thursday', label: 'Jueves', short: 'Ju' },
  { name: 'friday', label: 'Viernes', short: 'Vi' },
  { name: 'saturday', label: 'Sábado', short: 'Sá' },
  { name: 'sunday', label: 'Domingo', short: 'Do' },
];

function shiftError(status: number, data: unknown): string {
  const code = (data as { code?: string } | null)?.code;
  if (status === 409 && code === 'EXISTS') return 'Ya existe un turno con ese código.';
  if (status === 409 && code === 'VERSION_CONFLICT')
    return 'Otra persona modificó este turno. Cierre y vuelva a abrirlo.';
  if (status === 422) return 'El nombre y al menos un día laboral son obligatorios.';
  if (status === 403) return 'Se canceló la confirmación de identidad.';
  return NETWORK_ERROR;
}

export default function ShiftsPage() {
  const { call } = useAdmin();
  const [items, setItems] = useState<ShiftRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShiftRow | null>(null);

  const load = useCallback(async () => {
    const res = await call<ShiftRow[]>('/admin/shifts');
    if (res.status === 200 && res.data) setItems(res.data);
    else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const body = (f: FormData) => ({
    name: String(f.get('name') ?? ''),
    description: String(f.get('description') ?? '') || null,
    monday: f.get('monday') === 'on',
    tuesday: f.get('tuesday') === 'on',
    wednesday: f.get('wednesday') === 'on',
    thursday: f.get('thursday') === 'on',
    friday: f.get('friday') === 'on',
    saturday: f.get('saturday') === 'on',
    sunday: f.get('sunday') === 'on',
    active: f.get('active') === 'on',
  });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const res = editing
      ? await call(`/admin/shifts/${editing.id}`, {
          method: 'PUT',
          body: { ...body(f), version: editing.version },
        })
      : await call('/admin/shifts', {
          method: 'POST',
          body: { ...body(f), code: String(f.get('code') ?? '').trim() },
        });
    if (res.status === 200 || res.status === 201) {
      setOk(editing ? 'Turno actualizado.' : 'Turno creado.');
      setEditing(null);
      form.reset();
      await load();
    } else setError(shiftError(res.status, res.data));
  }

  return (
    <>
      <PageHeader title="Turnos" />
      <p className="muted">
        Cada turno define qué días de la semana son laborales para el cálculo de vacaciones (días
        hábiles y fecha de retorno). Un festivo publicado sigue restando el día aunque el turno lo
        marque como laboral. El campo Turno del empleado debe coincidir con el código de un turno de
        aquí para poder calcular sus vacaciones.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      <section className="import-panel" aria-label={editing ? 'Editar turno' : 'Nuevo turno'}>
        <h2>{editing ? `Editar «${editing.name}»` : 'Nuevo turno'}</h2>
        <form onSubmit={save} noValidate key={editing?.id ?? 'nuevo'}>
          <div className="grid-2">
            {editing ? null : (
              <Field
                label="Código (debe coincidir con TURNO del empleado)"
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
          </div>
          <Field
            label="Descripción"
            name="description"
            optional
            maxLength={300}
            defaultValue={editing?.description ?? ''}
          />
          <fieldset>
            <legend>Días laborales</legend>
            {DAYS.map((d) => (
              <label className="choice" key={d.name}>
                <input
                  type="checkbox"
                  name={d.name}
                  defaultChecked={editing ? Boolean(editing[d.name]) : false}
                />
                <span>{d.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="choice">
            <input type="checkbox" name="active" defaultChecked={editing?.active ?? true} />
            <span>Activo (se puede asignar y usar en el cálculo)</span>
          </label>
          <button type="submit">{editing ? 'Guardar cambios' : 'Crear turno'}</button>{' '}
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
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Turnos">
          <table>
            <caption className="muted">Turnos</caption>
            <thead>
              <tr>
                <th scope="col">Código</th>
                <th scope="col">Nombre</th>
                <th scope="col">Días laborales</th>
                <th scope="col">Estado</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{s.code}</td>
                  <td>{s.name}</td>
                  <td>
                    {DAYS.filter((d) => s[d.name])
                      .map((d) => d.short)
                      .join(', ') || '—'}
                  </td>
                  <td>
                    <Badge kind={s.active ? 'ok' : 'off'}>{s.active ? 'Activo' : 'Inactivo'}</Badge>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setEditing(s)}
                      aria-label={`Editar el turno ${s.name}`}
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Todavía no hay turnos. Cree el primero arriba.
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
