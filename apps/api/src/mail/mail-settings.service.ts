import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import { createTransport, type Transporter } from 'nodemailer';
import type { Db } from '../db/client';
import { auditLogs, mailSettings } from '../db/schema';
import { open, seal } from '../security/secret-box';

export type MailErrorCode =
  | 'INVALID_SETTINGS'
  | 'NOT_CONFIGURED'
  | 'INVALID_RECIPIENT'
  | 'CONNECTION_FAILED'
  | 'TLS_REQUIRED'
  | 'AUTH_FAILED'
  | 'REJECTED'
  | 'SEND_FAILED';

export class MailSettingsError extends Error {
  constructor(readonly code: MailErrorCode) {
    super(code);
  }
}

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  username: string | null;
  password: string | null;
  /** Encabezado From ya compuesto: `Nombre <correo>` o solo el correo. */
  from: string;
  fromEmail: string;
  fromName: string | null;
}

export interface MailSettingsInput {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  username?: string | null | undefined;
  password?: string | undefined;
  clearPassword?: boolean | undefined;
  /** Dirección de correo de origen, por ejemplo nomflow@gr4l.co. */
  fromEmail: string;
  /** Nombre que se muestra junto a la dirección (opcional). */
  fromName?: string | null | undefined;
}

const TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS ?? 10_000);
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const isEmail = (v: string) => EMAIL_RE.test(v) && v.length <= 254;

function validate(i: MailSettingsInput): boolean {
  const host = i.host.trim();
  return (
    (HOST_RE.test(host) || isIP(host) !== 0) &&
    Number.isInteger(i.port) &&
    i.port >= 1 &&
    i.port <= 65535 &&
    isEmail(i.fromEmail.trim()) &&
    (i.fromName == null || (i.fromName.length <= 80 && !/[<>\r\n"]/.test(i.fromName))) &&
    (i.username == null || i.username.length <= 200) &&
    (i.password == null || i.password.length <= 500)
  );
}

async function audit(db: Db, actor: string, action: string, result: string) {
  await db
    .insert(auditLogs)
    .values({ actorAccountId: actor, action, resource: 'mail_settings', resourceId: null, result });
}

/** Variables de entorno: respaldo cuando nadie ha guardado configuración desde la administración. */
/** Separa `Nombre <correo>` (formato de SMTP_FROM) en nombre y dirección. */
function splitFrom(raw: string): { email: string; name: string | null } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(raw);
  return m?.[2] ? { email: m[2], name: m[1]?.trim() || null } : { email: raw.trim(), name: null };
}

/** Compone el encabezado From a partir de la dirección y el nombre. */
export function composeFrom(email: string, name: string | null): string {
  return name ? `"${name}" <${email}>` : email;
}

export function envConfig(): MailConfig | null {
  if (!process.env.SMTP_HOST) return null;
  const from = splitFrom(process.env.SMTP_FROM ?? 'NOMFLOW <no-reply@localhost>');
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTls: process.env.SMTP_REQUIRE_TLS !== 'false',
    username: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASS || null,
    from: composeFrom(from.email, from.name),
    fromEmail: from.email,
    fromName: from.name,
  };
}

/** Configuración vigente: la guardada en la base y, si no hay, la del entorno. */
export async function effectiveConfig(db: Db): Promise<MailConfig | null> {
  const [s] = await db.select().from(mailSettings).where(eq(mailSettings.id, 1));
  if (!s) return envConfig();
  return {
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTls: s.requireTls,
    username: s.username,
    password: s.passwordEnc ? open(s.passwordEnc) : null,
    from: composeFrom(s.fromEmail, s.fromName),
    fromEmail: s.fromEmail,
    fromName: s.fromName,
  };
}

export function transportFor(c: MailConfig): Transporter {
  return createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    requireTLS: c.requireTls,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    auth: c.username ? { user: c.username, pass: c.password ?? '' } : undefined,
  });
}

/** Lo que ve el administrador: nunca incluye la clave. */
export async function getSettings(db: Db) {
  const [s] = await db.select().from(mailSettings).where(eq(mailSettings.id, 1));
  if (s)
    return {
      source: 'ADMINISTRACION' as const,
      configured: true,
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTls: s.requireTls,
      username: s.username,
      hasPassword: Boolean(s.passwordEnc),
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      lastTestAt: s.lastTestAt,
      lastTestStatus: s.lastTestStatus,
      updatedAt: s.updatedAt,
    };
  const e = envConfig();
  return {
    source: 'ENTORNO' as const,
    configured: Boolean(e),
    host: e?.host ?? '',
    port: e?.port ?? 25,
    secure: e?.secure ?? false,
    requireTls: e?.requireTls ?? true,
    username: e?.username ?? null,
    hasPassword: Boolean(e?.password),
    fromEmail: e?.fromEmail ?? '',
    fromName: e?.fromName ?? 'NOMFLOW',
    lastTestAt: null,
    lastTestStatus: null,
    updatedAt: null,
  };
}

export async function saveSettings(db: Db, actor: string, input: MailSettingsInput) {
  if (!validate(input)) {
    await audit(db, actor, 'MAIL_SETTINGS_SAVE', 'INVALID_SETTINGS');
    throw new MailSettingsError('INVALID_SETTINGS');
  }
  const [cur] = await db.select().from(mailSettings).where(eq(mailSettings.id, 1));
  const username = input.username?.trim() || null;
  // Sin usuario no hay clave; con usuario, una clave nueva la reemplaza y si no viene se conserva.
  const passwordEnc =
    !username || input.clearPassword
      ? null
      : input.password
        ? seal(input.password)
        : (cur?.passwordEnc ?? (envConfig()?.password ? seal(envConfig()?.password ?? '') : null));
  const values = {
    host: input.host.trim(),
    port: input.port,
    secure: input.secure,
    requireTls: input.requireTls,
    username,
    passwordEnc,
    fromEmail: input.fromEmail.trim(),
    fromName: input.fromName?.trim() || null,
    updatedBy: actor,
    updatedAt: new Date(),
  };
  await db
    .insert(mailSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: mailSettings.id, set: values });
  invalidateMailCache();
  await audit(
    db,
    actor,
    'MAIL_SETTINGS_SAVE',
    input.password ? 'SUCCESS_PASSWORD_CHANGED' : 'SUCCESS',
  );
}

/** Traduce el error del servidor de correo a un código que el administrador entienda. */
export function classify(e: unknown): MailErrorCode {
  const err = e as { code?: string; command?: string; responseCode?: number; message?: string };
  const msg = (err.message ?? '').toLowerCase();
  // Un servidor sin TLS contesta 502 a STARTTLS; también puede fallar el apretón de manos TLS.
  if (
    err.command === 'STARTTLS' ||
    msg.includes('starttls') ||
    msg.includes('wrong version number') ||
    msg.includes('ssl routines')
  )
    return 'TLS_REQUIRED';
  if (
    err.code === 'EAUTH' ||
    err.responseCode === 535 ||
    err.responseCode === 534 ||
    err.command === 'AUTH PLAIN' ||
    err.command === 'AUTH LOGIN'
  )
    return 'AUTH_FAILED';
  if (err.code === 'EENVELOPE' || (err.responseCode !== undefined && err.responseCode >= 500))
    return 'REJECTED';
  if (
    err.code === 'ECONNECTION' ||
    err.code === 'ESOCKET' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'EDNS' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'ECONNRESET'
  )
    return 'CONNECTION_FAILED';
  return 'SEND_FAILED';
}

/** Envía un correo de prueba con la configuración vigente y deja el resultado registrado. */
export async function sendTest(db: Db, actor: string, to: string) {
  if (!isEmail(to)) throw new MailSettingsError('INVALID_RECIPIENT');
  const cfg = await effectiveConfig(db);
  if (!cfg) throw new MailSettingsError('NOT_CONFIGURED');
  let status = 'OK';
  try {
    await transportFor(cfg).sendMail({
      from: cfg.from,
      to,
      subject: 'Prueba de correo de NOMFLOW',
      text: 'Este es un correo de prueba enviado desde la administración de NOMFLOW.\nSi lo recibe, la configuración del correo saliente funciona.',
    });
  } catch (e) {
    status = classify(e);
  }
  await db
    .update(mailSettings)
    .set({ lastTestAt: new Date(), lastTestStatus: status })
    .where(eq(mailSettings.id, 1));
  await audit(db, actor, 'MAIL_SETTINGS_TEST', status);
  if (status !== 'OK') throw new MailSettingsError(status as MailErrorCode);
}

/* ---- caché breve de la configuración usada al enviar ---- */

let cache: { at: number; cfg: MailConfig | null } | null = null;
const TTL_MS = 30_000;

export function invalidateMailCache(): void {
  cache = null;
}

export async function cachedConfig(db: Db): Promise<MailConfig | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  const cfg = await effectiveConfig(db);
  cache = { at: Date.now(), cfg };
  return cfg;
}
