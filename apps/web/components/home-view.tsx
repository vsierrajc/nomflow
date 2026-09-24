'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Loading } from '@/components/ui';
import { isAdmin } from '@/lib/admin';
import { api } from '@/lib/api';
import { displayName, roleView } from '@/lib/roles';
import { useReadyProfile } from '@/lib/use-profile';

type Vouchers = { status: 'loading' } | { status: 'error' } | { status: 'ready'; count: number };

export function HomeView() {
  const profile = useReadyProfile();
  const [vouchers, setVouchers] = useState<Vouchers>({ status: 'loading' });

  const loadVouchers = useCallback(async () => {
    setVouchers({ status: 'loading' });
    const res = await api<{ vouchers: unknown[] }>('/me/payroll');
    if (res.status === 200 && res.data)
      setVouchers({ status: 'ready', count: res.data.vouchers.length });
    else setVouchers({ status: 'error' });
  }, []);

  useEffect(() => {
    void loadVouchers();
  }, [loadVouchers]);

  const roles = profile.roles.map(roleView);
  const pendingApprover = profile.roles.some((r) => r.role === 'CERTIFICATE_APPROVER');
  const vacationApprover = profile.roles.some((r) =>
    ['AREA_MANAGER', 'VACATION_FINAL_APPROVER'].includes(r.role),
  );

  return (
    <>
      <div className="page-head">
        <h1>Hola, {displayName(profile.name, profile.email)}</h1>
        <p className="muted">
          Este es su espacio en NOMFLOW. Aquí encuentra lo que puede hacer hoy.
        </p>
      </div>

      <h2 className="sr-only">Lo que puede hacer</h2>
      <ul className="task-grid">
        <li className="task-card">
          <h3>Mis volantes de pago</h3>
          <p>Consulte y descargue sus volantes de pago en PDF.</p>
          {vouchers.status === 'loading' ? <Loading>Consultando…</Loading> : null}
          {vouchers.status === 'ready' ? (
            <p className="task-status">
              {vouchers.count === 0
                ? 'Aún no hay volantes publicados para usted.'
                : vouchers.count === 1
                  ? '1 volante disponible.'
                  : `${vouchers.count} volantes disponibles.`}
            </p>
          ) : null}
          {vouchers.status === 'error' ? (
            <p className="task-status">
              No se pudo consultar ahora.{' '}
              <button type="button" className="secondary small" onClick={() => void loadVouchers()}>
                Reintentar
              </button>
            </p>
          ) : null}
          <div className="actions">
            <Link className="button" href="/volantes">
              Consultar volantes
            </Link>
          </div>
        </li>
        <li className="task-card">
          <h3>Mis vacaciones</h3>
          <p>Solicite sus vacaciones y siga su aprobación.</p>
          <div className="actions">
            <Link className="button" href="/vacaciones">
              Solicitar vacaciones
            </Link>
          </div>
        </li>
        {vacationApprover ? (
          <li className="task-card">
            <h3>Aprobaciones</h3>
            <p>Revise y apruebe las solicitudes de vacaciones que le corresponden.</p>
            <div className="actions">
              <Link className="button" href="/aprobaciones">
                Ver aprobaciones
              </Link>
            </div>
          </li>
        ) : null}
        <li className="task-card">
          <h3>Mi cuenta</h3>
          <p>Revise sus datos de acceso y cambie su clave cuando lo necesite.</p>
          <div className="actions">
            <Link className="button secondary" href="/cuenta/clave">
              Cambiar mi clave
            </Link>
          </div>
        </li>
        {isAdmin(profile) ? (
          <li className="task-card">
            <h3>Administración</h3>
            <p>
              Gestione empresas, catálogos, empleados, cuentas, importaciones y consulte la
              auditoría.
            </p>
            <div className="actions">
              <Link className="button secondary" href="/admin">
                Abrir administración
              </Link>
            </div>
          </li>
        ) : null}
      </ul>

      <section className="panel" aria-labelledby="mis-datos">
        <h2 id="mis-datos" style={{ marginTop: 0 }}>
          Mis datos y roles
        </h2>
        <dl className="definition">
          <div>
            <dt>Nombre</dt>
            <dd>{displayName(profile.name, profile.email)}</dd>
          </div>
          <div>
            <dt>Correo de acceso</dt>
            <dd>{profile.email}</dd>
          </div>
        </dl>
        <h3>Roles asignados</h3>
        {roles.length === 0 ? (
          <p className="muted">
            No tiene roles asignados. Si cree que le falta alguno, solicítelo a Gestión Humana.
          </p>
        ) : (
          <ul className="role-list">
            {roles.map((r) => (
              <li key={r.key}>
                <strong>{r.title}</strong>
                <span>{r.detail}</span>
                {r.scope ? (
                  <span className="hint" style={{ display: 'block' }}>
                    {r.scope}
                  </span>
                ) : null}
                <span className="hint" style={{ display: 'block' }}>
                  {r.validity}
                </span>
              </li>
            ))}
          </ul>
        )}
        {pendingApprover ? (
          <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
            Su rol de aprobador de certificados queda registrado, pero ese flujo todavía no está
            disponible en NOMFLOW.
          </p>
        ) : null}
      </section>
    </>
  );
}
