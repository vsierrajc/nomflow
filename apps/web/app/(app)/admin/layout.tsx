'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { HealthBanner } from '@/components/health-banner';
import { AdminProvider, isAdmin } from '@/lib/admin';
import { useReadyProfile } from '@/lib/use-profile';

const NAV = [
  { href: '/admin', label: 'Resumen' },
  { href: '/admin/empresas', label: 'Empresas y logo' },
  { href: '/admin/catalogos', label: 'Áreas, cargos y centros de costo' },
  { href: '/admin/conceptos', label: 'Conceptos de nómina' },
  { href: '/admin/empleados', label: 'Empleados' },
  { href: '/admin/cuentas', label: 'Cuentas y roles' },
  { href: '/admin/correo', label: 'Correo saliente' },
  { href: '/admin/importaciones', label: 'Importaciones' },
  { href: '/admin/nomina', label: 'Nómina publicada' },
  { href: '/admin/vacaciones', label: 'Períodos de vacaciones' },
  { href: '/admin/festivos', label: 'Festivos' },
  { href: '/admin/tipos-permiso', label: 'Tipos de permiso' },
  { href: '/admin/retenciones', label: 'Certificados de retención' },
  { href: '/admin/salud', label: 'Salud del sistema' },
  { href: '/admin/auditoria', label: 'Auditoría' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const profile = useReadyProfile();

  if (!isAdmin(profile)) {
    return (
      <section className="panel narrow">
        <h1>Acceso restringido</h1>
        <p>Esta área es solo para el personal con perfil de administrador.</p>
        <div className="links">
          <Link href="/">Volver al inicio</Link>
        </div>
      </section>
    );
  }

  return (
    <AdminProvider profile={profile}>
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
        </nav>
        <section className="admin-content">
          <HealthBanner />
          {children}
        </section>
      </div>
    </AdminProvider>
  );
}
