import type { Db } from '../db/client';
import { cachedConfig, transportFor } from './mail-settings.service';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/** Envía con la configuración de la administración (o, si no hay, la del entorno), leída al enviar. */
export class ConfigurableMailer implements Mailer {
  constructor(private readonly db: Db) {}

  async send(to: string, subject: string, text: string): Promise<void> {
    const cfg = await cachedConfig(this.db);
    if (!cfg) throw new Error('SMTP no configurado');
    await transportFor(cfg).sendMail({ from: cfg.from, to, subject, text });
  }
}

export class UnconfiguredMailer implements Mailer {
  send(): Promise<void> {
    return Promise.reject(new Error('SMTP no configurado'));
  }
}
