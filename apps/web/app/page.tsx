'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Alert, Card } from '../components/ui';
import { NETWORK_ERROR, api } from '../lib/api';
import { useProfile, type Role } from '../lib/use-profile';

const ROLE_LABELS: Record<string, string> = {
  EMPLOYEE: 'Empleado',
  AREA_MANAGER: 'Jefe de área',
  VACATION_FINAL_APPROVER: 'Aprobador final de vacaciones',
  CERTIFICATE_APPROVER: 'Aprobador de certificados',
  HR_ADMIN: 'Administrador de Gestión Humana',
  SYSTEM_ADMIN: 'Administrador del sistema',
};

function describeRole(r: Role): string {
  const label = ROLE_LABELS[r.role] ?? r.role;
  const scope = [r.areaCode ? `área ${r.areaCode}` : null, r.cEmp ? `empresa ${r.cEmp}` : null]
    .filter(Boolean)
    .join(', ');
  return scope ? `${label} (${scope})` : label;
}

export default function HomePage() {
  const router = useRouter();
  const { state } = useProfile();

  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
  }, [state, router]);

  async function logout() {
    if (state.status !== 'ready') return;
    await api('/auth/logout', { method: 'POST', csrf: state.profile.csrfToken });
    router.replace('/login');
  }

  if (state.status === 'loading' || state.status === 'anonymous') {
    return <Card title="Inicio">Cargando…</Card>;
  }
  if (state.status === 'error') {
    return (
      <Card title="Inicio">
        <Alert kind="error">{NETWORK_ERROR}</Alert>
      </Card>
    );
  }

  const { profile } = state;
  return (
    <Card title={profile.name ? `Hola, ${profile.name}` : 'Bienvenido'}>
      <p className="muted">{profile.email}</p>
      <h2>Mis roles</h2>
      {profile.roles.length === 0 ? (
        <p className="muted">Sin roles asignados.</p>
      ) : (
        <ul className="roles">
          {profile.roles.map((r) => (
            <li key={`${r.role}-${r.cEmp}-${r.areaCode}-${r.validFrom}`}>{describeRole(r)}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <Link className="button" href="/volantes">
          Mis volantes de pago
        </Link>
        <Link className="button secondary" href="/cuenta/clave">
          Cambiar mi clave
        </Link>
        <button type="button" onClick={() => void logout()}>
          Cerrar sesión
        </button>
      </div>
    </Card>
  );
}
