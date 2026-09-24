'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice, PageHeader } from '@/components/admin-ui';
import { ImportPanel } from '@/components/import-panel';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';

interface Period {
  id: string;
  nIde: string;
  nCont: string;
  perIni: string;
  perFin: string;
  dias: number;
  disp: number;
  estado: 'ACTIVA' | 'LIQUIDADA';
  estOrigen: string | null;
  version: number;
}

export default function VacationPeriodsPage() {
  const { call, profile } = useAdmin();
  const [items, setItems] = useState<Period[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Period | null>(null);

  const load = useCallback(
    async (nIde = '') => {
      const res = await call<Period[]>(
        `/admin/prog-vac${nIde ? `?nIde=${encodeURIComponent(nIde)}` : ''}`,
      );
      if (res.status === 200 && res.data) setItems(res.data);
      else setError(NETWORK_ERROR);
    },
    [call],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function fail(status: number) {
    if (status === 400)
      setError(
        'Revise los datos: 0 ≤ disponibles ≤ días ≤ 15, fechas coherentes, motivo de al menos 10 caracteres y un empleado existente.',
      );
    else if (status === 409) setError('Ese período ya existe para el contrato.');
    else if (status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const res = await call('/admin/prog-vac', {
      method: 'POST',
      body: {
        nIde: String(f.get('nIde') ?? ''),
        nCont: String(f.get('nCont') ?? ''),
        perIni: String(f.get('perIni') ?? ''),
        perFin: String(f.get('perFin') ?? ''),
        dias: Number(f.get('dias')),
        disp: Number(f.get('disp')),
      },
    });
    if (res.status === 201) {
      setOk('Período creado.');
      form.reset();
      await load(filter);
    } else fail(res.status);
  }

  async function adjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    setOk(null);
    const f = new FormData(e.currentTarget);
    const res = await call(`/admin/prog-vac/${editing.id}`, {
      method: 'PUT',
      body: {
        dias: Number(f.get('dias')),
        disp: Number(f.get('disp')),
        reason: String(f.get('reason') ?? ''),
      },
    });
    if (res.status === 200) {
      setOk('Ajuste registrado con su motivo; el período subió de versión.');
      setEditing(null);
      await load(filter);
    } else fail(res.status);
  }

  async function remove(p: Period) {
    setError(null);
    setOk(null);
    const res = await call(`/admin/prog-vac/${p.id}`, { method: 'DELETE' });
    if (res.status === 204 || res.status === 200) {
      setOk('Período dado de baja.');
      await load(filter);
    } else fail(res.status);
  }

  return (
    <>
      <PageHeader title="Períodos de vacaciones" />
      <p className="muted">
        Días hábiles programados (<code>DIAS</code>) y disponibles (<code>DISP</code>) por contrato.
        Un período con 0 disponibles queda «Liquidada» y no se ofrece para nuevas solicitudes. Toda
        corrección exige motivo y queda versionada.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}

      <ImportPanel
        title="Importar períodos desde Excel (PROG_VAC)"
        endpoint="/admin/imports/prog-vac"
        defaultResponsible={profile.email}
        extraFields={[
          {
            name: 'fechaCorte',
            label: 'Fecha de corte (AAAA-MM-DD)',
            hint: 'Fecha a la que corresponden los días disponibles del archivo.',
            pattern: '\\d{4}-\\d{2}-\\d{2}',
            maxLength: 10,
          },
        ]}
        onApplied={() => void load(filter)}
      >
        <p className="muted">
          Columnas: N_IDE, N_CONT, PER_INI, PER_FIN, DIAS, DISP y EST. Las fechas van como
          DD/MM/AAAA. Se exige 0 ≤ DISP ≤ DIAS ≤ 15 y que el empleado ya esté importado. Si el
          período ya existe, la carga corrige sus días y deja el ajuste versionado con la fecha de
          corte; revise la vista previa (nuevos, modificados y sin cambios) antes de aplicar. Guarde
          N_IDE y N_CONT como texto para no perder ceros iniciales.
        </p>
      </ImportPanel>

      <section className="import-panel" aria-label="Nuevo período">
        <h2>Nuevo período</h2>
        <form onSubmit={create} noValidate>
          <div className="grid-2">
            <Field label="Identificación (N_IDE)" name="nIde" required maxLength={30} />
            <Field label="Contrato (N_CONT)" name="nCont" required maxLength={30} />
            <Field label="Inicio del período" name="perIni" type="date" required />
            <Field label="Fin del período" name="perFin" type="date" required />
            <Field label="Días hábiles programados (máx. 15)" name="dias" type="number" required />
            <Field label="Días hábiles disponibles" name="disp" type="number" required />
          </div>
          <button type="submit">Crear período</button>
        </form>
      </section>

      {editing ? (
        <section className="import-panel" aria-label="Ajustar período">
          <h2>
            Ajustar período {editing.perIni} a {editing.perFin} (empleado {editing.nIde})
          </h2>
          <form onSubmit={adjust} noValidate>
            <div className="grid-2">
              <Field
                label="Días programados"
                name="dias"
                type="number"
                defaultValue={editing.dias}
                required
              />
              <Field
                label="Días disponibles"
                name="disp"
                type="number"
                defaultValue={editing.disp}
                required
              />
            </div>
            <Field label="Motivo (mínimo 10 caracteres)" name="reason" required maxLength={300} />
            <button type="submit">Guardar ajuste</button>{' '}
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </form>
        </section>
      ) : null}

      <form
        className="toolbar"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const v = String(new FormData(e.currentTarget).get('nIde') ?? '').trim();
          setFilter(v);
          void load(v);
        }}
      >
        <Field label="Filtrar por identificación" name="nIde" maxLength={30} />
        <button type="submit" className="secondary">
          Filtrar
        </button>
      </form>

      {items === null ? (
        error ? null : (
          <p className="muted">Cargando…</p>
        )
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Períodos de vacaciones">
          <table>
            <caption className="muted">Períodos de vacaciones (hasta 500)</caption>
            <thead>
              <tr>
                <th scope="col">Empleado</th>
                <th scope="col">Contrato</th>
                <th scope="col">Período</th>
                <th scope="col">Días</th>
                <th scope="col">Disponibles</th>
                <th scope="col">Estado</th>
                <th scope="col">Versión</th>
                <th scope="col">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>{p.nIde}</td>
                  <td>{p.nCont}</td>
                  <td>
                    {p.perIni} a {p.perFin}
                  </td>
                  <td className="num">{p.dias}</td>
                  <td className="num">{p.disp}</td>
                  <td>
                    <Badge kind={p.estado === 'ACTIVA' ? 'ok' : 'off'}>
                      {p.estado === 'ACTIVA' ? 'Activa' : 'Liquidada'}
                    </Badge>
                  </td>
                  <td className="num">{p.version}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setEditing(p)}
                      aria-label={`Ajustar período ${p.perIni} a ${p.perFin} del empleado ${p.nIde}`}
                    >
                      Ajustar
                    </button>{' '}
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void remove(p)}
                      aria-label={`Dar de baja período ${p.perIni} a ${p.perFin} del empleado ${p.nIde}`}
                    >
                      Dar de baja
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    Todavía no hay períodos de vacaciones.
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
