export interface ApiResult<T> {
  status: number;
  data: T | null;
}

interface ApiInit {
  method?: string;
  body?: unknown;
  csrf?: string;
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
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

export const NETWORK_ERROR = 'No se pudo conectar con el servidor. Intente de nuevo.';
export const MIN_PASSWORD_LENGTH = 12;
