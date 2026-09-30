import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';

const url = process.env.DATABASE_URL;
const MAX = 3;

describe.skipIf(!url)('límite de intentos por IP en endpoints públicos', () => {
  const ctx = createDb(url ?? '');
  let app: INestApplication;

  beforeAll(async () => {
    await runMigrations(url ?? '');
    // Un límite bajo propio de esta prueba: el resto de la suite necesita AUTH_RATE_LIMIT_MAX alto
    // (fijado en vitest.config.ts) porque inicia sesión muchas veces por archivo. La constante se lee
    // al importar auth.controller.ts, así que hay que fijar el env antes de esa importación dinámica.
    process.env.AUTH_RATE_LIMIT_MAX = String(MAX);
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '900000';
    const { AppModule } = await import('../app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  it('bloquea con 429 al superar el máximo de peticiones por ventana', async () => {
    const srv = app.getHttpServer();
    for (let i = 0; i < MAX; i++) {
      const res = await request(srv).post('/auth/activate').send({});
      expect(res.status).toBe(400);
    }
    const blocked = await request(srv).post('/auth/activate').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('lleva un contador independiente por ruta', async () => {
    const srv = app.getHttpServer();
    for (let i = 0; i < MAX; i++) {
      await request(srv).post('/auth/verify-email/resend').send({ email: 'nadie@x.co' });
    }
    expect((await request(srv).post('/auth/verify-email/resend').send({})).status).toBe(429);
    // /auth/login no comparte contador con /auth/verify-email/resend.
    const login = await request(srv).post('/auth/login').send({ email: 'a@x.co', password: 'x' });
    expect(login.status).not.toBe(429);
  });
});
