'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, fetchBlob, upload as uploadForm, type ApiResult, type DownloadResult } from './api';
import type { Profile } from './use-profile';

export const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'];

export function isAdmin(profile: Profile): boolean {
  return profile.roles.some((r) => ADMIN_ROLES.includes(r.role));
}

export function isSystemAdmin(profile: Profile): boolean {
  return profile.roles.some((r) => r.role === 'SYSTEM_ADMIN');
}

interface CallInit {
  method?: string;
  body?: unknown;
}

interface AdminContextValue {
  profile: Profile;
  call: <T = unknown>(path: string, init?: CallInit) => Promise<ApiResult<T>>;
  send: <T = unknown>(path: string, form: FormData) => Promise<ApiResult<T>>;
  download: (path: string) => Promise<DownloadResult>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin fuera de AdminProvider');
  return ctx;
}

function needsReauth(status: number, data: unknown): boolean {
  return (
    status === 403 &&
    typeof data === 'object' &&
    data !== null &&
    (data as { code?: string }).code === 'REAUTH_REQUIRED'
  );
}

export function AdminProvider({ profile, children }: { profile: Profile; children: ReactNode }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiter = useRef<((ok: boolean) => void) | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);

  const ask = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    setError(null);
    setAsking(true);
    const p = new Promise<boolean>((resolve) => {
      waiter.current = (ok) => {
        pending.current = null;
        setAsking(false);
        resolve(ok);
      };
    });
    pending.current = p;
    return p;
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    setBusy(true);
    setError(null);
    const res = await api('/auth/reauth', {
      method: 'POST',
      csrf: profile.csrfToken,
      body: { password },
    });
    setBusy(false);
    if (res.status === 204) waiter.current?.(true);
    else if (res.status === 0) setError('No se pudo conectar con el servidor.');
    else setError('La clave es incorrecta.');
  }

  const call = useCallback(
    async <T,>(path: string, init: CallInit = {}): Promise<ApiResult<T>> => {
      const run = () => api<T>(path, { ...init, csrf: profile.csrfToken });
      const first = await run();
      if (!needsReauth(first.status, first.data)) return first;
      return (await ask()) ? run() : first;
    },
    [profile.csrfToken, ask],
  );

  const send = useCallback(
    async <T,>(path: string, form: FormData): Promise<ApiResult<T>> => {
      const first = await uploadForm<T>(path, form, profile.csrfToken);
      if (!needsReauth(first.status, first.data)) return first;
      return (await ask()) ? uploadForm<T>(path, form, profile.csrfToken) : first;
    },
    [profile.csrfToken, ask],
  );

  const download = useCallback(
    async (path: string): Promise<DownloadResult> => {
      const first = await fetchBlob(path);
      if (!needsReauth(first.status, first.data)) return first;
      return (await ask()) ? fetchBlob(path) : first;
    },
    [ask],
  );

  const value = useMemo(() => ({ profile, call, send, download }), [profile, call, send, download]);

  return (
    <AdminContext.Provider value={value}>
      {children}
      {asking ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
            <h2 id="reauth-title">Confirme su identidad</h2>
            <p className="muted">
              Por seguridad, esta acción requiere que vuelva a escribir su clave.
            </p>
            {error ? (
              <p className="alert alert-error" role="alert">
                {error}
              </p>
            ) : null}
            <form onSubmit={onSubmit}>
              <div className="field">
                <label htmlFor="reauth-password">Clave</label>
                <input
                  id="reauth-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                />
              </div>
              <div className="actions">
                <button type="submit" disabled={busy}>
                  {busy ? 'Verificando…' : 'Confirmar'}
                </button>
                <button type="button" className="secondary" onClick={() => waiter.current?.(false)}>
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AdminContext.Provider>
  );
}
