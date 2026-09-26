export interface ApiResult<T> {
  status: number;
  data: T | null;
}

interface ApiInit {
  method?: string;
  body?: unknown;
  csrf?: string;
}

/**
 * La sesión caduca por inactividad (30 minutos) o se cierra desde otro lugar. Si una petición de la
 * aplicación recibe 401, se lleva a la persona al ingreso con un aviso claro en lugar de mostrarle un
 * falso «no se pudo conectar con el servidor».
 */
function leaveIfExpired(path: string, status: number, data: unknown): void {
  if (status !== 401 || path.startsWith('/auth/') || typeof window === 'undefined') return;
  // Solo la falta de sesión responde «Unauthorized»; una clave o código incorrectos traen su propio mensaje.
  if ((data as { message?: string } | null)?.message !== 'Unauthorized') return;
  if (window.location.pathname.startsWith('/login')) return;
  window.location.assign('/login?expirada=1');
}

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.csrf) headers['X-CSRF-Token'] = init.csrf;
  try {
    const res = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    let data: T | null = null;
    if (res.status !== 204) {
      try {
        data = (await res.json()) as T;
      } catch {
        data = null;
      }
    }
    leaveIfExpired(path, res.status, data);
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

export const NETWORK_ERROR = 'No se pudo conectar con el servidor. Intente de nuevo.';
export const MIN_PASSWORD_LENGTH = 12;

export async function upload<T = unknown>(
  path: string,
  form: FormData,
  csrf: string,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      cache: 'no-store',
      body: form,
    });
    let data: T | null = null;
    if (res.status !== 204) {
      try {
        data = (await res.json()) as T;
      } catch {
        data = null;
      }
    }
    leaveIfExpired(path, res.status, data);
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

export interface DownloadResult {
  status: number;
  blob: Blob | null;
  filename: string | null;
  data: unknown;
}

export async function fetchBlob(path: string): Promise<DownloadResult> {
  try {
    const res = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      const disposition = res.headers.get('content-disposition') ?? '';
      const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? null;
      return { status: res.status, blob: await res.blob(), filename: name, data: null };
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    leaveIfExpired(path, res.status, data);
    return { status: res.status, blob: null, filename: null, data };
  } catch {
    return { status: 0, blob: null, filename: null, data: null };
  }
}
