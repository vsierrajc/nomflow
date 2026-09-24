'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/cuenta/clave', label: 'Cambiar clave' },
  { href: '/cuenta/seguridad', label: 'Verificación en dos pasos' },
];

/** Navegación entre las pantallas de «Mi cuenta». */
export function AccountTabs() {
  const pathname = usePathname();
  return (
    <nav className="admin-nav" aria-label="Mi cuenta">
      <ul>
        {TABS.map((t) => (
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
