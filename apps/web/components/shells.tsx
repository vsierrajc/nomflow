'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
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
    text: 'Solicite permisos a su jefe de área y consulte su respuesta.',
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
              <strong>{sv.title}</strong>
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
    { href: '/bandeja', label: 'Bandeja de entrada', match: (p) => p.startsWith('/bandeja') },
    { href: '/volantes', label: 'Mis volantes de pago', match: (p) => p.startsWith('/volantes') },
    { href: '/vacaciones', label: 'Mis vacaciones', match: (p) => p.startsWith('/vacaciones') },
    { href: '/permisos', label: 'Mis permisos', match: (p) => p.startsWith('/permisos') },
    {
      href: '/certificado-laboral',
      label: 'Certificado laboral',
      match: (p) => p.startsWith('/certificado-laboral'),
    },
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
  if (profile.roles.some((r) => r.role === 'CERTIFICATE_APPROVER'))
    items.push({
      href: '/firma-certificados',
      label: 'Mi firma de certificados',
      match: (p) => p.startsWith('/firma-certificados'),
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
  const [pending, setPending] = useState(0);

  // Actividades pendientes en la insignia del menú; se actualiza al cambiar de pantalla.
  useEffect(() => {
    let alive = true;
    void api<{ pending: number }>('/me/inbox/count').then((res) => {
      if (alive && res.status === 200 && res.data) setPending(res.data.pending);
    });
    return () => {
      alive = false;
    };
  }, [pathname]);
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
            aria-controls="menu-lateral"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Cerrar menú' : 'Menú'}
          </button>
        </div>
      </header>
      <div className="app-body">
        <aside id="menu-lateral" className={`app-side${menu}`}>
          <nav id="menu-principal" aria-label="Principal" className="app-nav">
            {navFor(profile).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.match(pathname) ? 'page' : undefined}
                onClick={() => setOpen(false)}
              >
                {item.label}
                {item.href === '/bandeja' && pending > 0 ? (
                  <span className="nav-count" aria-label={`${pending} pendientes`}>
                    {pending}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="app-user">
            <span className="app-user-label">Usuario</span>
            <span className="app-user-name">{displayName(profile.name, profile.email)}</span>
            <button type="button" className="secondary small" onClick={onLogout}>
              Cerrar sesión
            </button>
          </div>
        </aside>
        <main id="contenido" tabIndex={-1} className={`app-main${wide ? ' admin' : ''}`}>
          {children}
        </main>
      </div>
      <footer className="app-foot">NOMFLOW - Portal de autogestión del empleado</footer>
    </div>
  );
}

export async function requestLogout(csrf: string): Promise<void> {
  await api('/auth/logout', { method: 'POST', csrf });
}
