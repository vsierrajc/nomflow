'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAdmin } from '@/lib/admin';
import { APPROVER_ROLES } from '@/lib/roles';

const TABS = [
  { href: '/cuenta/clave', label: 'Cambiar clave' },
  { href: '/cuenta/seguridad', label: 'Verificación en dos pasos' },
  { href: '/cuenta/apariencia', label: 'Apariencia' },
];

/** Solo quienes aprueban vacaciones tienen firma de aprobación. */
const APPROVER_TABS = [
  { href: '/cuenta/firma', label: 'Mi firma de aprobación' },
  { href: '/cuenta/suplencias', label: 'Mis suplencias' },
];

/** Navegación entre las pantallas de «Mi cuenta». */
export function AccountTabs() {
  const pathname = usePathname();
  const { profile } = useAdmin();
  const tabs = profile.roles.some((r) => APPROVER_ROLES.includes(r.role))
    ? [...TABS, ...APPROVER_TABS]
    : TABS;
  return (
    <nav className="admin-nav" aria-label="Mi cuenta">
      <ul>
        {tabs.map((t) => (
          <li key={t.href}>
            <Link href={t.href} aria-current={pathname.startsWith(t.href) ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
