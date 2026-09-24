'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Card } from '../../components/ui';
import { AdminProvider, isAdmin } from '../../lib/admin';
import { useProfile } from '../../lib/use-profile';

const NAV = [
  { href: '/admin', label: 'Resumen' },
  { href: '/admin/empresas', label: 'Empresas y logo' },
  { href: '/admin/catalogos', label: 'Áreas, cargos y centros de costo' },
  { href: '/admin/conceptos', label: 'Conceptos de nómina' },
  { href: '/admin/empleados', label: 'Empleados' },
  { href: '/admin/cuentas', label: 'Cuentas y roles' },
  { href: '/admin/importaciones', label: 'Importaciones' },
  { href: '/admin/nomina', label: 'Nómina publicada' },
  { href: '/admin/auditoria', label: 'Auditoría' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useProfile();

  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
  }, [state, router]);

  if (state.status === 'loading' || state.status === 'anonymous') {
    return <Card title="Administración">Cargando…</Card>;
  }
  if (state.status === 'error') {
    return <Card title="Administración">No se pudo cargar su sesión. Intente de nuevo.</Card>;
  }
  if (!isAdmin(state.profile)) {
    return (
      <Card title="Acceso restringido">
        <p>Esta área es solo para el personal con perfil de administrador.</p>
        <div className="links">
          <Link href="/">Volver al inicio</Link>
        </div>
      </Card>
    );
  }

  return (
    <AdminProvider profile={state.profile}>
      <div className="admin-shell">
        <nav className="admin-nav" aria-label="Administración">
          <ul>
            {NAV.map((item) => {
              const current =
                item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={current ? 'page' : undefined}>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <Link className="muted" href="/">
            Salir del área administrativa
          </Link>
        </nav>
        <section className="admin-content">{children}</section>
      </div>
    </AdminProvider>
  );
}
