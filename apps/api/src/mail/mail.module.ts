import { Global, Module } from '@nestjs/common';
import { MAILER, SmtpMailer, UnconfiguredMailer } from './mailer';

@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      useFactory: () => (process.env.SMTP_HOST ? new SmtpMailer() : new UnconfiguredMailer()),
    },
  ],
  exports: [MAILER],
})
export class MailModule {}
