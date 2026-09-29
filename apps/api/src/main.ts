import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { getSessionSecret } from './auth/session.service';

async function bootstrap(): Promise<void> {
  getSessionSecret();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable('x-powered-by');
  // Detrás de un proxy reverso (balanceador, nginx), req.ip debe leer X-Forwarded-For en vez de
  // la IP del proxy; sin TRUST_PROXY (despliegue directo) se deja el valor por omisión de Express.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const hops = Number(trustProxy);
    app.set('trust proxy', Number.isNaN(hops) ? trustProxy : hops);
  }
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000));
}
void bootstrap();
