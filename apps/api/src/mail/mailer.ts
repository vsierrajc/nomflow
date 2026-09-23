import { createTransport } from 'nodemailer';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

export class SmtpMailer implements Mailer {
  private readonly transport = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined,
  });

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({
      from: process.env.SMTP_FROM ?? 'NOMFLOW <no-reply@localhost>',
      to,
      subject,
      text,
    });
  }
}

export class UnconfiguredMailer implements Mailer {
  send(): Promise<void> {
    return Promise.reject(new Error('SMTP no configurado'));
  }
}
