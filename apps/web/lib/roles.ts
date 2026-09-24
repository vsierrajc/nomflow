import type { Role } from './use-profile';

export interface RoleView {
  key: string;
  title: string;
  detail: string;
  scope: string | null;
  validity: string;
  approver: boolean;
}

const BASE: Record<string, { title: string; detail: string; approver: boolean }> = {
  EMPLOYEE: {
    title: 'Empleado',
    detail: 'Consulta sus propios datos y documentos.',
    approver: false,
  },
  AREA_MANAGER: {
    title: 'Jefe de área',
    detail: 'Persona responsable de un área de la empresa.',
    approver: true,
  },
  VACATION_FINAL_APPROVER: {
    title: 'Aprobador final de vacaciones',
    detail: 'Da la aprobación final a las solicitudes de vacaciones.',
    approver: true,
  },
  CERTIFICATE_APPROVER: {
    title: 'Aprobador de certificados',
    detail: 'Revisa y firma los certificados laborales.',
    approver: true,
  },
  HR_ADMIN: {
    title: 'Administrador de Gestión Humana',
    detail: 'Gestiona empresas, catálogos, empleados, cuentas e importaciones.',
    approver: false,
  },
  SYSTEM_ADMIN: {
    title: 'Administrador del sistema',
    detail: 'Gestiona lo mismo que Gestión Humana y además los roles administrativos.',
    approver: false,
  },
};

const dateFormat = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });

function longDate(iso: string): string {
  return dateFormat.format(new Date(`${iso}T00:00:00Z`));
}

export function roleView(r: Role): RoleView {
  const base = BASE[r.role] ?? { title: r.role, detail: '', approver: false };
  const scope = [r.areaCode ? `Área ${r.areaCode}` : null, r.cEmp ? `Empresa ${r.cEmp}` : null]
    .filter(Boolean)
    .join(' - ');
  const validity = r.validTo
    ? `Vigente del ${longDate(r.validFrom)} al ${longDate(r.validTo)}`
    : `Vigente desde el ${longDate(r.validFrom)}`;
  return {
    key: `${r.role}-${r.cEmp}-${r.areaCode}-${r.validFrom}`,
    title: base.title,
    detail: base.detail,
    scope: scope || null,
    validity,
    approver: base.approver,
  };
}

export function displayName(name: string | null, email: string): string {
  if (!name) return email;
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(' ');
}
