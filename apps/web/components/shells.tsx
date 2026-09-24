'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { isAdmin } from '@/lib/admin';
import { displayName } from '@/lib/roles';
import type { Profile } from '@/lib/use-profile';

export function BrandMark() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="9" fill="currentColor" opacity="0.18" />
      <rect x="11" y="7" width="18" height="26" rx="3" fill="currentColor" />
      <rect x="15" y="13" width="10" height="2" rx="1" fill="var(--color-surface)" />
      <rect x="15" y="18" width="7" height="2" rx="1" fill="var(--color-surface)" opacity="0.7" />
      <circle
        cx="27"
        cy="29"
        r="6"
        fill="var(--color-ok-text)"
        stroke="var(--color-surface)"
        strokeWidth="2"
      />
      <path
        d="M24.2 29.2l2 2 3.4-3.8"
        fill="none"
        stroke="var(--color-surface)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return <div className="landing-shell">{children}</div>;
  return (
    <div className="auth-shell">
      <p className="auth-brand brand-mark">
        <BrandMark />
        <span>NOMFLOW</span>
      </p>
      {children}
    </div>
  );
}

const LANDING_SERVICES = [
  {
    title: 'Volantes de pago',
    text: 'Consulte y descargue sus volantes de cada quincena en PDF.',
  },
  {
    title: 'Certificados de retención',
    text: 'Visualice y descargue su certificado de retención de cada año.',
  },
  {
    title: 'Vacaciones',
    text: 'Solicite sus vacaciones y siga su aprobación en línea.',
  },
  {
    title: 'Permisos',
    text: 'Solicitudes y aprobaciones en línea.',
    soon: true,
  },
];

/** Portada de la pantalla de ingreso: marca, mensaje y servicios junto a la tarjeta de acceso. */
export function LoginLanding({
  title,
  lead,
  help,
  children,
}: {
  title: string;
  lead: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <section className="landing-hero" aria-labelledby="landing-titular">
        <p className="brand-mark landing-brand">
          <BrandMark />
          <span>NOMFLOW</span>
        </p>
        <h2 id="landing-titular">Su información laboral, en un solo lugar</h2>
        <p className="landing-lead">
          El portal de autogestión de los empleados: consulte sus documentos y gestione sus
          solicitudes sin desplazarse ni esperar.
        </p>
        <ul className="landing-services">
          {LANDING_SERVICES.map((sv) => (
            <li key={sv.title}>
              <strong>
                {sv.title}
                {sv.soon ? <span className="landing-soon"> (próximamente)</span> : null}
              </strong>
              <span>{sv.text}</span>
            </li>
          ))}
        </ul>
        <p className="landing-note">Acceso seguro con su correo corporativo.</p>
      </section>
      <div className="landing-access">
        <main id="contenido" tabIndex={-1} className="auth-main">
          <h1>{title}</h1>
          <p className="auth-lead">{lead}</p>
          {children}
        </main>
        {help ? <div className="auth-help">{help}</div> : null}
      </div>
    </>
  );
}

export function AuthCard({
  title,
  lead,
  wide = false,
  help,
  children,
}: {
  title: string;
  lead?: string;
  wide?: boolean;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <main id="contenido" tabIndex={-1} className={`auth-main${wide ? ' wide' : ''}`}>
        <h1>{title}</h1>
        {lead ? <p className="auth-lead">{lead}</p> : null}
        {children}
      </main>
      {help ? <div className={`auth-help${wide ? ' wide' : ''}`}>{help}</div> : null}
    </>
  );
}

interface NavItem {
  href: string;
  label: string;
  match: (path: string) => boolean;
}

function navFor(profile: Profile): NavItem[] {
  const items: NavItem[] = [
    { href: '/', label: 'Inicio', match: (p) => p === '/' },
    { href: '/volantes', label: 'Mis volantes de pago', match: (p) => p.startsWith('/volantes') },
    { href: '/vacaciones', label: 'Mis vacaciones', match: (p) => p.startsWith('/vacaciones') },
    {
      href: '/retenciones',
      label: 'Certificados de retención',
      match: (p) => p.startsWith('/retenciones'),
    },
    { href: '/cuenta/clave', label: 'Mi cuenta', match: (p) => p.startsWith('/cuenta') },
  ];
  if (profile.roles.some((r) => ['AREA_MANAGER', 'VACATION_FINAL_APPROVER'].includes(r.role)))
    items.push({
      href: '/aprobaciones',
      label: 'Aprobaciones',
      match: (p) => p.startsWith('/aprobaciones'),
    });
  if (isAdmin(profile))
    items.push({ href: '/admin', label: 'Administración', match: (p) => p.startsWith('/admin') });
  return items;
}

export function AppShell({
  profile,
  onLogout,
  children,
}: {
  profile: Profile;
  onLogout: () => void;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const wide = pathname.startsWith('/admin');
  const menu = open ? ' open' : '';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <Link href="/" className="brand-mark app-brand">
            <BrandMark />
            <span>NOMFLOW</span>
          </Link>
          <button
            type="button"
            className="menu-toggle secondary"
            aria-expanded={open}
            aria-controls="menu-principal"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Cerrar menú' : 'Menú'}
          </button>
          <nav id="menu-principal" aria-label="Principal" className={`app-nav${menu}`}>
            {navFor(profile).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.match(pathname) ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className={`app-user${menu}`}>
            <span className="app-user-name">{displayName(profile.name, profile.email)}</span>
            <button type="button" className="secondary small" onClick={onLogout}>
              Cerrar sesión
            </button>
          </div>
        </div>
      </header>
      <main id="contenido" tabIndex={-1} className={`app-main${wide ? ' admin' : ''}`}>
        {children}
      </main>
      <footer className="app-foot">NOMFLOW - Portal de autogestión del empleado</footer>
    </div>
  );
}

export async function requestLogout(csrf: string): Promise<void> {
  await api('/auth/logout', { method: 'POST', csrf });
}
