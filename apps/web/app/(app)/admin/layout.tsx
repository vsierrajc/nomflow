'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { HealthBanner } from '@/components/health-banner';
import { AdminProvider, isAdmin } from '@/lib/admin';
import { useReadyProfile } from '@/lib/use-profile';

interface NavItem {
  href: string;
  label: string;
}

const HOME: NavItem = { href: '/admin', label: 'Resumen' };

/** El menú se agrupa por lo que hace cada pantalla: datos maestros, trabajo diario, documentos y sistema. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Entidades',
    items: [
      { href: '/admin/empresas', label: 'Empresas y logo' },
      { href: '/admin/catalogos', label: 'Áreas, cargos y centros de costo' },
      { href: '/admin/conceptos', label: 'Conceptos de nómina' },
      { href: '/admin/tipos-permiso', label: 'Tipos de permiso' },
      { href: '/admin/festivos', label: 'Festivos' },
    ],
  },
  {
    title: 'Operaciones',
    items: [
      { href: '/admin/empleados', label: 'Empleados' },
      { href: '/admin/cuentas', label: 'Cuentas y roles' },
      { href: '/admin/importaciones', label: 'Importaciones' },
      { href: '/admin/nomina', label: 'Nómina publicada' },
      { href: '/admin/vacaciones', label: 'Períodos de vacaciones' },
    ],
  },
  {
    title: 'Certificados',
    items: [
      { href: '/admin/retenciones', label: 'Certificados de retención' },
      { href: '/admin/certificado-laboral', label: 'Certificado laboral' },
      { href: '/admin/certificados-emitidos', label: 'Certificados laborales emitidos' },
    ],
  },
  {
    title: 'Sistema',
    items: [
      { href: '/admin/correo', label: 'Correo saliente' },
      { href: '/admin/notificaciones', label: 'Notificaciones del flujo' },
      { href: '/admin/salud', label: 'Salud del sistema' },
      { href: '/admin/archivo', label: 'Archivo histórico' },
      { href: '/admin/auditoria', label: 'Auditoría' },
      { href: '/admin/registros', label: 'Registros y depuración' },
    ],
  },
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
            <li>
              <Link href={HOME.href} aria-current={pathname === HOME.href ? 'page' : undefined}>
                {HOME.label}
              </Link>
            </li>
          </ul>
          {GROUPS.map((g) => (
            <section key={g.title} aria-labelledby={`admin-grupo-${g.title}`}>
              <h2 className="admin-nav-title" id={`admin-grupo-${g.title}`}>
                {g.title}
              </h2>
              <ul>
                {g.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <section className="admin-content">
          <HealthBanner />
          {children}
        </section>
      </div>
    </AdminProvider>
  );
}
