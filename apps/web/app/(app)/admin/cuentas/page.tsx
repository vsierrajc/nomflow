'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Modal,
  Notice,
  PageHeader,
  Pager,
  SelectField,
  formatDate,
} from '@/components/admin-ui';
import { Field } from '@/components/ui';
import { NETWORK_ERROR } from '@/lib/api';
import { isSystemAdmin, useAdmin } from '@/lib/admin';

interface Account {
  id: string;
  email: string;
  nIde: string;
  status: 'ACTIVA' | 'PENDIENTE_VERIFICACION' | 'BLOQUEADA';
  mustChangePassword: boolean;
  createdAt: string;
  name: string | null;
  roles: string[];
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  items: Account[];
}

interface RoleRow {
  id: string;
  role: string;
  companyCode: string | null;
  areaCode: string | null;
  validFrom: string;
  validTo: string | null;
}

interface Manager {
  id: string;
  managerAccountId: string;
  validFrom: string;
  validTo: string | null;
}

const PAGE_SIZE = 25;
const ROLE_LABELS: Record<string, string> = {
  EMPLOYEE: 'Empleado',
  AREA_MANAGER: 'Jefe de área',
  VACATION_FINAL_APPROVER: 'Aprobador final de vacaciones',
  CERTIFICATE_APPROVER: 'Aprobador de certificados',
  HR_ADMIN: 'Administrador de Gestión Humana',
  SYSTEM_ADMIN: 'Administrador del sistema',
};
const STATUS: Record<string, { label: string; kind: 'ok' | 'warn' | 'off' }> = {
  ACTIVA: { label: 'Activa', kind: 'ok' },
  PENDIENTE_VERIFICACION: { label: 'Pendiente de activar', kind: 'warn' },
  BLOQUEADA: { label: 'Bloqueada', kind: 'off' },
};
const today = () => new Date().toISOString().slice(0, 10);

function SecretDialog({
  title,
  secret,
  sent,
  onClose,
}: {
  title: string;
  secret: string;
  sent: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p>
        Esta clave temporal se muestra <strong>una sola vez</strong>. Entréguela a la persona por un
        canal distinto al correo y pídale que la cambie al activar su cuenta.
      </p>
      <p className="secret" data-testid="temporary-password">
        {secret}
      </p>
      <p className={sent ? 'muted' : ''}>
        {sent
          ? 'Se envió un código de verificación al correo registrado.'
          : 'No se pudo enviar el código por correo: la persona puede pedirlo de nuevo en la pantalla de activación.'}
      </p>
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copiada' : 'Copiar clave'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Ya la entregué
        </button>
      </div>
    </Modal>
  );
}

function CreateDialog({
  onCreated,
  onClose,
}: {
  onCreated: (secret: string, sent: boolean) => void;
  onClose: () => void;
}) {
  const { call } = useAdmin();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nIde = String(new FormData(e.currentTarget).get('nIde') ?? '').trim();
    setBusy(true);
    setError(null);
    const res = await call<{ temporaryPassword: string; verificationSent: boolean; code?: string }>(
      '/admin/accounts',
      { method: 'POST', body: { nIde } },
    );
    setBusy(false);
    if (res.status === 201 && res.data)
      onCreated(res.data.temporaryPassword, res.data.verificationSent);
    else if (res.status === 404)
      setError('No hay ningún empleado con esa identificación. Impórtelo primero.');
    else if (res.status === 409) setError('Esa persona ya tiene una cuenta.');
    else if (res.status === 422) {
      const map: Record<string, string> = {
        NO_ACTIVE_CONTRACT: 'La persona no tiene exactamente un contrato vigente.',
        EMAIL_MISSING: 'El empleado no tiene correo registrado.',
      };
      setError(
        map[res.data?.code ?? ''] ??
          'No se puede crear la cuenta con los datos actuales del empleado.',
      );
    } else if (res.status === 400) setError('Escriba la identificación del empleado.');
    else if (res.status === 403) setError('Se canceló la confirmación de identidad.');
    else setError(NETWORK_ERROR);
  }

  return (
    <Modal title="Crear cuenta de empleado" onClose={onClose}>
      <p className="muted">
        La cuenta usa el correo registrado en el empleado. Se genera una clave temporal y se envía
        un código de verificación a ese correo.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <form onSubmit={onSubmit} noValidate>
        <Field label="Identificación del empleado (N_IDE)" name="nIde" required maxLength={30} />
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Creando…' : 'Crear cuenta'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RolesDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const { call, profile } = useAdmin();
  const system = isSystemAdmin(profile);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [managers, setManagers] = useState<Record<string, Manager[]>>({});
  const [role, setRole] = useState('AREA_MANAGER');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const self = account.id === profile.accountId;

  const load = useCallback(async () => {
    const res = await call<RoleRow[]>(`/admin/accounts/${account.id}/roles`);
    if (res.status !== 200 || !res.data) return;
    setRoles(res.data);
    const next: Record<string, Manager[]> = {};
    for (const r of res.data.filter(
      (x) => x.role === 'AREA_MANAGER' && x.companyCode && x.areaCode,
    )) {
      const m = await call<Manager[]>(`/admin/areas/${r.companyCode}/${r.areaCode}/managers`);
      if (m.status === 200 && m.data)
        next[r.id] = m.data.filter((x) => x.managerAccountId === account.id);
    }
    setManagers(next);
  }, [call, account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const roleErrors: Record<string, string> = {
    FORBIDDEN: 'Solo un administrador del sistema puede gestionar roles administrativos.',
    SELF_GRANT: 'Nadie puede modificar sus propios roles.',
    SCOPE_REQUIRED: 'Este rol necesita empresa (y el jefe de área también su área).',
    COMPANY_NOT_FOUND: 'Esa empresa no está registrada.',
    AREA_NOT_FOUND: 'Esa área no existe en el catálogo de la empresa.',
    INVALID_RANGE: 'Las fechas no son válidas.',
    MANAGER_NOT_ELIGIBLE:
      'La cuenta debe estar activa y tener el rol de jefe de esa área que cubra el período.',
    OVERLAP: 'Ya hay un jefe asignado a esa área en ese período.',
  };

  function explain(status: number, data: { code?: string } | null): string {
    if (status === 403 && data?.code && roleErrors[data.code]) return roleErrors[data.code] ?? '';
    if (status === 403) return 'Se canceló la confirmación de identidad o no tiene permiso.';
    if (data?.code && roleErrors[data.code]) return roleErrors[data.code] ?? '';
    if (status === 404) return 'No se encontró el registro (¿el área existe?).';
    if (status === 409) return roleErrors.OVERLAP ?? '';
    return NETWORK_ERROR;
  }

  async function grant(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    setError(null);
    setOk(null);
    const body: Record<string, string | null> = {
      role,
      validFrom: v('validFrom') || today(),
      validTo: v('validTo') || null,
    };
    if (role === 'VACATION_FINAL_APPROVER') body.cEmp = v('cEmp');
    if (role === 'AREA_MANAGER') {
      body.cEmp = v('cEmp');
      body.areaCode = v('areaCode');
    }
    const res = await call<{ code?: string }>(`/admin/accounts/${account.id}/roles`, {
      method: 'POST',
      body,
    });
    if (res.status === 201) {
      setOk('Rol concedido.');
      void load();
    } else setError(explain(res.status, res.data));
  }

  async function end(r: RoleRow) {
    setError(null);
    setOk(null);
    const res = await call<{ code?: string }>(`/admin/accounts/${account.id}/roles/${r.id}/end`, {
      method: 'PUT',
      body: {},
    });
    if (res.status === 204) {
      setOk('Rol terminado a partir de hoy.');
      void load();
    } else setError(explain(res.status, res.data));
  }

  async function assign(r: RoleRow) {
    setError(null);
    setOk(null);
    const res = await call<{ code?: string }>('/admin/areas/managers', {
      method: 'POST',
      body: {
        cEmp: r.companyCode,
        cArea: r.areaCode,
        managerAccountId: account.id,
        validFrom: r.validFrom > today() ? r.validFrom : today(),
        validTo: r.validTo,
      },
    });
    if (res.status === 201) {
      setOk(`Asignada como jefe del área ${r.areaCode}.`);
      void load();
    } else setError(explain(res.status, res.data));
  }

  async function endAssignment(m: Manager) {
    setError(null);
    setOk(null);
    const res = await call<{ code?: string }>(`/admin/areas/managers/${m.id}/end`, {
      method: 'PUT',
      body: { validTo: today() },
    });
    if (res.status === 204) {
      setOk('Jefatura terminada a partir de hoy.');
      void load();
    } else setError(explain(res.status, res.data));
  }

  const privileged = (r: string) => r === 'HR_ADMIN' || r === 'SYSTEM_ADMIN';
  const roleOptions = Object.entries(ROLE_LABELS)
    .filter(([k]) => system || !privileged(k))
    .map(([value, label]) => ({ value, label }));

  return (
    <Modal title={`Roles de ${account.email}`} onClose={onClose} wide>
      {self ? (
        <Notice kind="error">Está viendo su propia cuenta: no puede modificar sus roles.</Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {ok ? <Notice kind="ok">{ok}</Notice> : null}
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Roles de la cuenta">
        <table>
          <caption className="muted">Roles de la cuenta</caption>
          <thead>
            <tr>
              <th scope="col">Rol</th>
              <th scope="col">Alcance</th>
              <th scope="col">Desde</th>
              <th scope="col">Hasta</th>
              <th scope="col">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => {
              const mine = managers[r.id] ?? [];
              const open = mine.some((m) => !m.validTo || m.validTo >= today());
              const expired = r.validTo !== null && r.validTo < today();
              return (
                <tr key={r.id}>
                  <td>{ROLE_LABELS[r.role] ?? r.role}</td>
                  <td>{r.areaCode ? `Área ${r.areaCode} (${r.companyCode})` : '-'}</td>
                  <td>{r.validFrom}</td>
                  <td>{r.validTo ?? 'Sin fecha de fin'}</td>
                  <td>
                    <div className="row-actions">
                      {expired || self ? null : (
                        <button
                          type="button"
                          className="danger small"
                          onClick={() => void end(r)}
                          aria-label={`Terminar rol ${ROLE_LABELS[r.role] ?? r.role}`}
                        >
                          Terminar rol
                        </button>
                      )}
                      {r.role === 'AREA_MANAGER' && !expired && !open ? (
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => void assign(r)}
                          aria-label={`Asignar como jefe del área ${r.areaCode}`}
                        >
                          Asignar como jefe del área
                        </button>
                      ) : null}
                      {r.role === 'AREA_MANAGER' && open
                        ? mine
                            .filter((m) => !m.validTo || m.validTo >= today())
                            .map((m) => (
                              <span key={m.id}>
                                <Badge kind="ok">Jefe vigente</Badge>{' '}
                                <button
                                  type="button"
                                  className="secondary small"
                                  onClick={() => void endAssignment(m)}
                                >
                                  Terminar jefatura
                                </button>
                              </span>
                            ))
                        : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {roles.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  Sin roles asignados.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {self ? null : (
        <form onSubmit={grant} noValidate>
          <h3>Conceder un rol</h3>
          <div className="grid-2">
            <SelectField
              label="Rol"
              name="role"
              value={role}
              onChange={setRole}
              options={roleOptions}
            />
            {role === 'AREA_MANAGER' || role === 'VACATION_FINAL_APPROVER' ? (
              <Field label="Empresa (código)" name="cEmp" required maxLength={30} />
            ) : null}
            {role === 'AREA_MANAGER' ? (
              <Field label="Área (código)" name="areaCode" required maxLength={30} />
            ) : null}
            <Field label="Vigente desde" name="validFrom" type="date" defaultValue={today()} />
            <Field label="Vigente hasta (opcional)" name="validTo" type="date" />
          </div>
          <div className="actions">
            <button type="submit">Conceder rol</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function AccountsPage() {
  const { call, profile } = useAdmin();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string; sent: boolean } | null>(
    null,
  );
  const [rolesOf, setRolesOf] = useState<Account | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('q', q);
    if (status) params.set('status', status);
    const res = await call<Page>(`/admin/accounts?${params.toString()}`);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setError(null);
    } else setError(NETWORK_ERROR);
  }, [call, q, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(a: Account, action: 'block' | 'unblock' | 'reset-password') {
    setError(null);
    setNotice(null);
    const res = await call<{
      temporaryPassword?: string;
      verificationSent?: boolean;
      status?: string;
      code?: string;
    }>(`/admin/accounts/${a.id}/${action}`, { method: 'POST', body: {} });
    if (action === 'reset-password' && res.status === 200 && res.data?.temporaryPassword) {
      setSecret({
        title: `Nueva clave temporal de ${a.email}`,
        value: res.data.temporaryPassword,
        sent: Boolean(res.data.verificationSent),
      });
      void load();
    } else if (res.status === 200 || res.status === 204) {
      setNotice(
        action === 'block' ? 'Cuenta bloqueada y sesiones cerradas.' : 'Cuenta desbloqueada.',
      );
      void load();
    } else if (res.status === 403)
      setError(
        'No permitido: no puede actuar sobre su propia cuenta ni sobre administradores (solo un administrador del sistema), o se canceló la confirmación.',
      );
    else if (res.status === 409)
      setError(
        'La acción no aplica al estado actual de la cuenta (por ejemplo, ya existe otra cuenta activa con ese correo).',
      );
    else if (res.status === 422)
      setError('La persona no tiene un contrato vigente: no se puede restablecer su clave.');
    else setError(NETWORK_ERROR);
  }

  return (
    <>
      <PageHeader title="Cuentas y roles">
        <button type="button" onClick={() => setCreating(true)}>
          Crear cuenta
        </button>
      </PageHeader>
      <div className="toolbar">
        <Field
          label="Buscar por correo o identificación"
          name="q"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label="Estado"
          name="status"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: '', label: 'Todos' },
            { value: 'ACTIVA', label: 'Activas' },
            { value: 'PENDIENTE_VERIFICACION', label: 'Pendientes de activar' },
            { value: 'BLOQUEADA', label: 'Bloqueadas' },
          ]}
        />
      </div>
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {data ? (
        <>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Cuentas">
            <table>
              <caption className="muted">Cuentas</caption>
              <thead>
                <tr>
                  <th scope="col">Correo</th>
                  <th scope="col">Nombre</th>
                  <th scope="col">Identificación</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Roles vigentes</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => {
                  const st = STATUS[a.status] ?? { label: a.status, kind: 'off' as const };
                  const mine = a.id === profile.accountId;
                  return (
                    <tr key={a.id}>
                      <td>{a.email}</td>
                      <td>{a.name ?? '-'}</td>
                      <td>{a.nIde}</td>
                      <td>
                        <Badge kind={st.kind}>{st.label}</Badge>
                      </td>
                      <td>{a.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || '-'}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => setRolesOf(a)}
                            aria-label={`Roles de ${a.email}`}
                          >
                            Roles
                          </button>
                          {mine ? null : a.status === 'BLOQUEADA' ? (
                            <button
                              type="button"
                              className="secondary small"
                              onClick={() => void act(a, 'unblock')}
                              aria-label={`Desbloquear ${a.email}`}
                            >
                              Desbloquear
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="secondary small"
                                onClick={() => void act(a, 'reset-password')}
                                aria-label={`Restablecer clave de ${a.email}`}
                              >
                                Restablecer clave
                              </button>
                              <button
                                type="button"
                                className="danger small"
                                onClick={() => void act(a, 'block')}
                                aria-label={`Bloquear ${a.email}`}
                              >
                                Bloquear
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {data.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No hay cuentas con esos criterios.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      ) : error ? null : (
        <p className="muted">Cargando…</p>
      )}
      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(value, sent) => {
            setCreating(false);
            setSecret({ title: 'Cuenta creada', value, sent });
            void load();
          }}
        />
      ) : null}
      {secret ? (
        <SecretDialog
          title={secret.title}
          secret={secret.value}
          sent={secret.sent}
          onClose={() => setSecret(null)}
        />
      ) : null}
      {rolesOf ? (
        <RolesDialog
          account={rolesOf}
          onClose={() => {
            setRolesOf(null);
            void load();
          }}
        />
      ) : null}
      <p className="muted" style={{ marginTop: 16 }}>
        Última actualización: {formatDate(new Date().toISOString())}
      </p>
    </>
  );
}
