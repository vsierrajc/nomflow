'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Notice } from '@/components/admin-ui';
import { EmptyState, Field, Loading } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { useAdmin } from '@/lib/admin';
import {
  PHASE_LABEL,
  dateLabel,
  phaseKind,
  substitutionError,
  type MySubstitutions,
  type Substitution,
} from '@/lib/substitutions';

interface Candidate {
  id: string;
  name: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Quien aprueba designa a su suplente por un rango de fechas y ve en qué suplencias participa. */
export default function SubstitutionsPage() {
  const { call } = useAdmin();
  const [data, setData] = useState<MySubstitutions | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await call<MySubstitutions>('/me/substitutions');
    if (res.status === 200 && res.data) {
      setData(res.data);
      if (res.data.eligible) {
        const c = await call<Candidate[]>('/me/substitutions/candidates');
        if (c.status === 200 && c.data) setCandidates(c.data);
      }
    } else setError(NETWORK_ERROR);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function designate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOk(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    const substituteAccountId = String(f.get('substitute') ?? '');
    const validFrom = String(f.get('from') ?? '');
    const validTo = String(f.get('to') ?? '');
    if (!substituteAccountId) return setError('Elija a la persona que lo suplirá.');
    if (!validFrom || !validTo) return setError('Escriba la fecha inicial y la final.');
    const res = await call('/me/substitutions', {
      method: 'POST',
      body: { substituteAccountId, validFrom, validTo },
    });
    if (res.status === 201) {
      setOk(
        'Suplencia registrada. En esas fechas su suplente decidirá lo que le corresponde a usted.',
      );
      form.reset();
      await load();
    } else setError(substitutionError(res.status, res.data, NETWORK_ERROR));
  }

  async function end(id: string) {
    setError(null);
    setOk(null);
    const res = await call(`/me/substitutions/${id}/end`, { method: 'POST', body: {} });
    setConfirming(null);
    if (res.status === 204) {
      setOk('La suplencia terminó. Usted vuelve a decidir lo que le corresponde.');
      await load();
    } else setError(substitutionError(res.status, res.data, NETWORK_ERROR));
  }

  const row = (s: Substitution, who: string, actions: boolean) => (
    <tr key={s.id}>
      <td>{who}</td>
      <td>{dateLabel(s.validFrom)}</td>
      <td>{dateLabel(s.validTo)}</td>
      <td>
        <Badge kind={phaseKind(s.phase)}>{PHASE_LABEL[s.phase]}</Badge>
        {s.endReason ? <span className="muted"> {s.endReason}</span> : null}
      </td>
      {actions ? (
        <td>
          {s.status === 'ACTIVA' && (s.phase === 'VIGENTE' || s.phase === 'PROGRAMADA') ? (
            confirming === s.id ? (
              <div className="row-actions">
                <span role="alert" className="muted">
                  ¿Terminarla?
                </span>
                <button type="button" className="danger" onClick={() => void end(s.id)}>
                  Sí, terminar
                </button>
                <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="secondary"
                aria-label={`Terminar la suplencia de ${who} del ${dateLabel(s.validFrom)} al ${dateLabel(s.validTo)}`}
                onClick={() => setConfirming(s.id)}
              >
                Terminar
              </button>
            )
          ) : null}
        </td>
      ) : null}
    </tr>
  );

  return (
    <>
      <div className="page-head">
        <h1>Mis suplencias</h1>
        <p className="muted">
          Cuando no pueda aprobar, designe a quien lo supla. Durante las fechas elegidas, su
          suplente decide las solicitudes de vacaciones y permisos que le corresponden a usted,
          incluidas las que ya estaban pendientes, y usted no. Puede terminarla antes; Gestión
          Humana también puede anularla. Todo queda registrado.
        </p>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      {data === null && !error ? <Loading>Consultando…</Loading> : null}
      {data !== null && !data.eligible && data.asSubstitute.length === 0 ? (
        <EmptyState title="No tiene un rol que apruebe solicitudes.">
          <p>Las suplencias son para quienes deciden vacaciones o permisos.</p>
        </EmptyState>
      ) : null}

      {data?.eligible ? (
        <section className="panel" aria-labelledby="designar">
          <h2 id="designar">Designar un suplente</h2>
          <form onSubmit={(e) => void designate(e)} noValidate>
            <div className="field">
              <label htmlFor="suplente">Quién lo suplirá</label>
              <select id="suplente" name="substitute" defaultValue="">
                <option value="">- Elija una persona -</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className="hint">
                Solo aparecen personas con un rol que aprueba solicitudes en su misma empresa.
              </p>
            </div>
            <div className="grid-2">
              <Field label="Desde" name="from" type="date" min={today()} required />
              <Field
                label="Hasta"
                name="to"
                type="date"
                min={today()}
                required
                hint={`Hasta ${data.maxDays} días en total; no puede empezar en el pasado.`}
              />
            </div>
            <button type="submit">Designar suplente</button>
          </form>
        </section>
      ) : null}

      {data && data.asTitular.length > 0 ? (
        <section className="panel" aria-labelledby="mias">
          <h2 id="mias">Mis suplentes</h2>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Suplencias que designé"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Suplente</th>
                  <th scope="col">Desde</th>
                  <th scope="col">Hasta</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>{data.asTitular.map((s) => row(s, s.substitute, true))}</tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data && data.asSubstitute.length > 0 ? (
        <section className="panel" aria-labelledby="suplo">
          <h2 id="suplo">Personas a quienes suplo</h2>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Suplencias en que participo"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Titular</th>
                  <th scope="col">Desde</th>
                  <th scope="col">Hasta</th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>{data.asSubstitute.map((s) => row(s, s.titular, false))}</tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
