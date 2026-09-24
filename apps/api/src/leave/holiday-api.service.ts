import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLogs, holidayApiSettings, holidayCalendars, holidays } from '../db/schema';
import { isValidIsoDate } from './business-days';
import { REGION, createDraft, HolidayError } from './holidays.service';
import { open, seal } from './secret-box';

export type HolidayApiErrorCode =
  | 'INVALID_URL'
  | 'NOT_CONFIGURED'
  | 'NO_API_KEY'
  | 'INVALID_YEAR'
  | 'API_KEY_INVALID'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE';

export class HolidayApiError extends Error {
  constructor(readonly code: HolidayApiErrorCode) {
    super(code);
  }
}

const TIMEOUT_MS = Number(process.env.HOLIDAY_API_TIMEOUT_MS ?? 10_000);
const production = () => process.env.NODE_ENV === 'production';

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  )
    return true;
  if (isIP(h) === 4) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(h) === 6)
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

/**
 * URL del servicio, sin el año ni credenciales. En producción se exige https y se rechazan
 * direcciones locales o privadas (SSRF); en desarrollo y pruebas se permiten.
 */
export function validateServiceUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HolidayApiError('INVALID_URL');
  }
  const okScheme = u.protocol === 'https:' || (!production() && u.protocol === 'http:');
  if (!okScheme || u.username || u.password || u.search || u.hash)
    throw new HolidayApiError('INVALID_URL');
  if (production() && process.env.HOLIDAY_API_ALLOW_PRIVATE !== 'true' && isPrivateHost(u.hostname))
    throw new HolidayApiError('INVALID_URL');
  return u;
}

async function audit(db: Db, actor: string, action: string, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'holiday_api', resourceId: null, result });
}

/** Estado visible para el administrador: nunca incluye la clave. */
export async function getSettings(db: Db) {
  const [s] = await db.select().from(holidayApiSettings).where(eq(holidayApiSettings.id, 1));
  if (!s)
    return {
      configured: false,
      url: null,
      hasApiKey: false,
      lastSyncAt: null,
      lastSyncYear: null,
      lastSyncStatus: null,
      updatedAt: null,
    };
  return {
    configured: true,
    url: s.url,
    hasApiKey: Boolean(s.apiKeyEnc),
    lastSyncAt: s.lastSyncAt,
    lastSyncYear: s.lastSyncYear,
    lastSyncStatus: s.lastSyncStatus,
    updatedAt: s.updatedAt,
  };
}

/** Guarda URL y clave. Si `apiKey` no viene, se conserva la anterior; con `clearApiKey` se borra. */
export async function saveSettings(
  db: Db,
  actor: string,
  input: { url: string; apiKey?: string | undefined; clearApiKey?: boolean | undefined },
) {
  let url: URL;
  try {
    url = validateServiceUrl(input.url);
  } catch (e) {
    await audit(db, actor, 'HOLIDAY_API_CONFIG', 'INVALID_URL');
    throw e;
  }
  const [cur] = await db.select().from(holidayApiSettings).where(eq(holidayApiSettings.id, 1));
  const apiKeyEnc = input.clearApiKey
    ? null
    : input.apiKey && input.apiKey.trim()
      ? seal(input.apiKey.trim())
      : (cur?.apiKeyEnc ?? null);
  const values = { url: url.toString(), apiKeyEnc, updatedBy: actor, updatedAt: new Date() };
  await db
    .insert(holidayApiSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: holidayApiSettings.id, set: values });
  await audit(db, actor, 'HOLIDAY_API_CONFIG', input.apiKey ? 'SUCCESS_KEY_CHANGED' : 'SUCCESS');
}

interface ApiDay {
  date: string;
  name: string;
}

function parseBody(body: unknown, year: number): ApiDay[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) throw new HolidayApiError('INVALID_RESPONSE');
  const out: ApiDay[] = [];
  for (const d of data) {
    const date = (d as { date?: unknown })?.date;
    const name =
      (d as { name_es?: unknown; name?: unknown })?.name_es ?? (d as { name?: unknown })?.name;
    if (
      typeof date !== 'string' ||
      !isValidIsoDate(date) ||
      !date.startsWith(`${year}-`) ||
      typeof name !== 'string' ||
      !name.trim()
    )
      throw new HolidayApiError('INVALID_RESPONSE');
    out.push({ date, name: name.trim().slice(0, 100) });
  }
  if (new Set(out.map((d) => d.date)).size !== out.length)
    throw new HolidayApiError('INVALID_RESPONSE');
  return out;
}

async function fetchYear(url: string, apiKey: string, year: number): Promise<ApiDay[]> {
  const target = new URL(url);
  target.searchParams.set('year', String(year));
  let res: Response;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HolidayApiError('UNAVAILABLE');
  }
  if (res.status === 401 || res.status === 403) throw new HolidayApiError('API_KEY_INVALID');
  if (res.status === 429) throw new HolidayApiError('RATE_LIMITED');
  if (res.status !== 200) throw new HolidayApiError('UNAVAILABLE');
  try {
    return parseBody(await res.json(), year);
  } catch (e) {
    if (e instanceof HolidayApiError) throw e;
    throw new HolidayApiError('INVALID_RESPONSE');
  }
}

/**
 * Consulta un año y lo deja como borrador con origen API; no publica ni altera lo publicado.
 * Devuelve las diferencias contra el calendario publicado para que el administrador decida.
 */
export async function syncYear(db: Db, actor: string, year: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new HolidayApiError('INVALID_YEAR');
  const [s] = await db.select().from(holidayApiSettings).where(eq(holidayApiSettings.id, 1));
  if (!s) throw new HolidayApiError('NOT_CONFIGURED');
  if (!s.apiKeyEnc) throw new HolidayApiError('NO_API_KEY');
  const record = async (status: string) => {
    await db
      .update(holidayApiSettings)
      .set({ lastSyncAt: new Date(), lastSyncYear: year, lastSyncStatus: status })
      .where(eq(holidayApiSettings.id, 1));
    await audit(db, actor, 'HOLIDAY_API_SYNC', status);
  };
  let days: ApiDay[];
  try {
    days = await fetchYear(s.url, open(s.apiKeyEnc), year);
  } catch (e) {
    await record(e instanceof HolidayApiError ? e.code : 'UNAVAILABLE');
    throw e;
  }
  let draft: { id: string; version: number };
  try {
    draft = await createDraft(
      db,
      actor,
      year,
      days,
      'API',
      `Sincronizado desde el servicio de festivos (${days.length} días)`,
    );
  } catch (e) {
    await record('INVALID_RESPONSE');
    if (e instanceof HolidayError) throw new HolidayApiError('INVALID_RESPONSE');
    throw e;
  }
  const diff = await diffAgainstPublished(db, year, days);
  await record('OK');
  return { ...draft, year, days: days.length, ...diff };
}

/** Fechas que el servicio trae y no están en el calendario publicado, y viceversa. */
async function diffAgainstPublished(db: Db, year: number, days: ApiDay[]) {
  const published = await db
    .select({ date: holidays.date })
    .from(holidays)
    .innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
    .where(
      and(
        eq(holidayCalendars.status, 'PUBLICADO'),
        eq(holidayCalendars.year, year),
        eq(holidayCalendars.region, REGION),
      ),
    );
  const have = new Set(published.map((p) => p.date));
  const incoming = new Set(days.map((d) => d.date));
  return {
    hadPublished: published.length > 0,
    added: days.filter((d) => !have.has(d.date)).map((d) => d.date),
    removed: [...have].filter((d) => !incoming.has(d)),
  };
}
