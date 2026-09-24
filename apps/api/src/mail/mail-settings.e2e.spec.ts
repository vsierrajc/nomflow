import { createServer, type Server, type Socket } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  auditLogs,
  employeeSnapshots,
  mailSettings,
  roleAssignments,
} from '../db/schema';
import { MAILER, type Mailer } from './mailer';
import { classify } from './mail-settings.service';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const SMTP_USER = 'notificador';
const SMTP_PASS = 'clave-smtp-SECRETA-123';
type Sess = { cookie: string; csrf: string };
type Received = { from: string; to: string[]; data: string };

/** Servidor SMTP mínimo para las pruebas: sin TLS, con AUTH opcional y rechazo opcional de destinatarios. */
function fakeSmtp(opts: { auth?: boolean; rejectRcpt?: boolean } = {}) {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let authed = false;
    let mail: Received = { from: '', to: [], data: '' };
    let inData = false;
    let buf = '';
    let authStep: 'user' | 'pass' | null = null;
    let authUser = '';
    const say = (s: string) => sock.write(`${s}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (inData) {
        if (!buf.includes('\r\n.\r\n')) return;
        mail.data = buf.slice(0, buf.indexOf('\r\n.\r\n'));
        received.push(mail);
        mail = { from: '', to: [], data: '' };
        buf = '';
        inData = false;
        return say('250 OK');
      }
      while (buf.includes('\r\n')) {
        const line = buf.slice(0, buf.indexOf('\r\n'));
        buf = buf.slice(buf.indexOf('\r\n') + 2);
        const up = line.toUpperCase();
        const b64 = (t: string) => Buffer.from(t, 'base64').toString('utf8');
        if (authStep === 'user') {
          authUser = b64(line);
          authStep = 'pass';
          say(`334 ${Buffer.from('Password:').toString('base64')}`);
        } else if (authStep === 'pass') {
          authStep = null;
          authed = authUser === SMTP_USER && b64(line) === SMTP_PASS;
          say(authed ? '235 OK' : '535 5.7.8 credenciales inválidas');
        } else if (up.startsWith('EHLO') || up.startsWith('HELO')) {
          say(opts.auth ? '250-fake\r\n250 AUTH PLAIN LOGIN' : '250 fake');
        } else if (up.startsWith('AUTH PLAIN')) {
          const [, u, p] = b64(line.split(' ')[2] ?? '').split('\0');
          authed = u === SMTP_USER && p === SMTP_PASS;
          say(authed ? '235 OK' : '535 5.7.8 credenciales inválidas');
        } else if (up.startsWith('AUTH LOGIN')) {
          authStep = 'user';
          say(`334 ${Buffer.from('Username:').toString('base64')}`);
        } else if (up === 'STARTTLS') {
          say('502 5.5.1 Error: command not implemented'); // como un Postfix sin TLS
        } else if (up.startsWith('MAIL FROM')) {
          if (opts.auth && !authed) return say('530 5.7.0 se requiere autenticación');
          mail.from = line.slice(10);
          say('250 OK');
        } else if (up.startsWith('RCPT TO')) {
          if (opts.rejectRcpt) say('550 5.1.1 destinatario rechazado');
          else {
            mail.to.push(line.slice(8));
            say('250 OK');
          }
        } else if (up === 'DATA') {
          inData = true;
          say('354 fin con .');
        } else if (up === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('250 OK');
      }
    });
  });
  return {
    received,
    start: () =>
      new Promise<number>((r) =>
        server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
      ),
    stop: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        for (const sk of sockets) sk.destroy(); // no esperar a conexiones que un fallo dejó abiertas
      }),
  };
}

describe('classify: errores reales del servidor de correo', () => {
  it('reconoce los casos de un Postfix interno', () => {
    expect(
      classify({
        command: 'STARTTLS',
        responseCode: 502,
        message: 'Error: command not implemented',
      }),
    ).toBe('TLS_REQUIRED');
    expect(
      classify({
        code: 'ESOCKET',
        message: 'error:0A00010B:SSL routines:ssl3_get_record:wrong version number',
      }),
    ).toBe('TLS_REQUIRED');
    expect(classify({ code: 'EAUTH', responseCode: 535, message: 'Invalid login' })).toBe(
      'AUTH_FAILED',
    );
    expect(classify({ command: 'AUTH PLAIN', responseCode: 530 })).toBe('AUTH_FAILED');
    expect(classify({ code: 'EENVELOPE', responseCode: 550, message: 'user unknown' })).toBe(
      'REJECTED',
    );
    expect(classify({ code: 'ECONNECTION', message: 'connect ECONNREFUSED' })).toBe(
      'CONNECTION_FAILED',
    );
    expect(classify({ code: 'ETIMEDOUT' })).toBe('CONNECTION_FAILED');
    expect(classify(new Error('algo inesperado'))).toBe('SEND_FAILED');
  });
});

describe.skipIf(!url)(
  'configuración del correo (HTTP + PostgreSQL + servidor SMTP de prueba)',
  () => {
    const ctx = createDb(url ?? '');
    const db = ctx.db;
    let app: INestApplication;
    let hr: Sess;
    let emp: Sess;
    const srv = () => app.getHttpServer();
    let smtp: ReturnType<typeof fakeSmtp> | null = null;
    let envHost: string | undefined;

    beforeAll(async () => {
      await runMigrations(url ?? '');
      envHost = process.env.SMTP_HOST;
      delete process.env.SMTP_HOST; // la prueba parte de "sin configurar"
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
    });
    afterAll(async () => {
      if (envHost) process.env.SMTP_HOST = envHost;
      await smtp?.stop();
      await app.close();
      await ctx.pool.end();
    });

    async function person(nIde: string, email: string, admin = false): Promise<Sess> {
      await db
        .insert(employeeSnapshots)
        .values({ nIde, nCont: '1', email, est: 'V', nombre: nIde });
      const [a] = await db
        .insert(accounts)
        .values({
          nIde,
          email,
          passwordHash: await hashPassword(PASSWORD),
          status: 'ACTIVA',
          mustChangePassword: false,
        })
        .returning({ id: accounts.id });
      if (admin)
        await db
          .insert(roleAssignments)
          .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
      const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
      return {
        cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
        csrf: res.body.csrfToken as string,
      };
    }
    const call = (s: Sess, method: 'get' | 'put' | 'post', path: string, body?: object) => {
      const r = request(srv())[method](path).set('Cookie', s.cookie);
      return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
    };
    const settings = () => call(hr, 'get', '/admin/mail-settings').expect(200);
    const save = (port: number, extra: object = {}) =>
      call(hr, 'put', '/admin/mail-settings', {
        host: '127.0.0.1',
        port,
        secure: false,
        requireTls: false,
        fromEmail: 'notificaciones@empresa.co',
        fromName: 'NOMFLOW',
        ...extra,
      });
    const test = (to = 'destino@empresa.co') =>
      call(hr, 'post', '/admin/mail-settings/test', { to });

    beforeEach(async () => {
      await smtp?.stop();
      smtp = null;
      await db.execute(
        sql`TRUNCATE mail_settings, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
      );
      hr = await person('ADM', 'adm@x.co', true);
      emp = await person('100', 'e@x.co');
    });

    it('sin configuración lo dice, y valida los datos antes de guardar', async () => {
      expect((await settings()).body).toMatchObject({ configured: false, source: 'ENTORNO' });
      await test().expect(400); // nada que probar
      const bad = (over: object) =>
        call(hr, 'put', '/admin/mail-settings', {
          host: 'mail.empresa.co',
          port: 25,
          secure: false,
          requireTls: false,
          from: 'a@empresa.co',
          ...over,
        });
      await bad({ host: 'host con espacios' }).expect(400);
      await bad({ host: 'x;rm -rf' }).expect(400);
      await bad({ port: 0 }).expect(400);
      await bad({ port: 70000 }).expect(400);
      await bad({ fromEmail: 'sin-arroba' }).expect(400);
      await bad({ fromEmail: 'a@b' }).expect(400);
      await bad({ fromEmail: 'a@b.co\r\nBcc: x@y.co' }).expect(400); // sin inyección de encabezados
      await bad({ fromEmail: 'a@empresa.co', fromName: 'Nombre <malo>' }).expect(400);
      await bad({ fromEmail: 'a@empresa.co', fromName: 'x'.repeat(81) }).expect(400);
      // el servidor interno acordado: 192.168.1.44:25, sin TLS, usuario ni clave
      await bad({
        host: '192.168.1.44',
        port: 25,
        fromEmail: 'nomflow@gr4l.co',
        fromName: 'NOMFLOW',
      }).expect(200);
      expect((await settings()).body).toMatchObject({
        source: 'ADMINISTRACION',
        host: '192.168.1.44',
        port: 25,
        secure: false,
        requireTls: false,
        username: null,
        hasPassword: false,
        fromEmail: 'nomflow@gr4l.co',
        fromName: 'NOMFLOW',
      });
      expect(await db.select().from(mailSettings)).toHaveLength(1);
    });

    it('solo administradores; nunca devuelve la clave', async () => {
      await call(emp, 'get', '/admin/mail-settings').expect(403);
      await call(emp, 'put', '/admin/mail-settings', {
        host: 'x.co',
        port: 25,
        secure: false,
        requireTls: false,
        from: 'a@x.co',
      }).expect(403);
      await call(emp, 'post', '/admin/mail-settings/test', { to: 'a@x.co' }).expect(403);
      await request(srv()).get('/admin/mail-settings').expect(401);
      smtp = fakeSmtp({ auth: true });
      const port = await smtp.start();
      const saved = await save(port, { username: SMTP_USER, password: SMTP_PASS }).expect(200);
      expect(saved.body).toMatchObject({ username: SMTP_USER, hasPassword: true });
      expect(JSON.stringify(saved.body)).not.toContain(SMTP_PASS);
      expect(JSON.stringify((await settings()).body)).not.toContain(SMTP_PASS);
      const [row] = await db.select().from(mailSettings);
      expect(row?.passwordEnc).toBeTruthy();
      expect(row?.passwordEnc).not.toContain(SMTP_PASS);
      expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain(SMTP_PASS);
    });

    it('envía el correo de prueba con la configuración guardada y registra el resultado', async () => {
      smtp = fakeSmtp();
      const port = await smtp.start();
      await save(port).expect(200);
      await test('rrhh@empresa.co').expect(200);
      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]?.to.join()).toContain('rrhh@empresa.co');
      expect(smtp.received[0]?.from).toContain('notificaciones@empresa.co');
      expect(smtp.received[0]?.data).toContain('From: NOMFLOW <notificaciones@empresa.co>');
      expect(smtp.received[0]?.data).toContain('Subject: Prueba de correo de NOMFLOW');
      expect((await settings()).body).toMatchObject({ lastTestStatus: 'OK' });
      await test('no es un correo').expect(400);
      await test('a@b').expect(400);
    });

    it('el remitente lleva la dirección de origen, con o sin nombre', async () => {
      smtp = fakeSmtp();
      const port = await smtp.start();
      await save(port, { fromEmail: 'nomflow@gr4l.co', fromName: 'NOMFLOW' }).expect(200);
      await test().expect(200);
      await save(port, { fromEmail: 'nomflow@gr4l.co', fromName: '' }).expect(200);
      await test().expect(200);
      expect(smtp.received[0]?.from).toContain('nomflow@gr4l.co');
      expect(smtp.received[0]?.data).toContain('From: NOMFLOW <nomflow@gr4l.co>');
      expect(smtp.received[1]?.from).toContain('nomflow@gr4l.co');
      expect(smtp.received[1]?.data).toMatch(/From: nomflow@gr4l\.co/);
      expect((await settings()).body).toMatchObject({
        fromEmail: 'nomflow@gr4l.co',
        fromName: null,
      });
    });

    it('sin configuración guardada usa las variables de entorno y separa SMTP_FROM', async () => {
      process.env.SMTP_HOST = 'correo.interno';
      process.env.SMTP_FROM = '"Portal NOMFLOW" <nomflow@gr4l.co>';
      try {
        expect((await settings()).body).toMatchObject({
          source: 'ENTORNO',
          configured: true,
          host: 'correo.interno',
          fromEmail: 'nomflow@gr4l.co',
          fromName: 'Portal NOMFLOW',
        });
      } finally {
        delete process.env.SMTP_HOST;
        delete process.env.SMTP_FROM;
      }
    });

    it('autenticación: usuario y clave correctos, incorrectos, conservar y borrar la clave', async () => {
      smtp = fakeSmtp({ auth: true });
      const port = await smtp.start();
      await save(port, { username: SMTP_USER, password: 'incorrecta' }).expect(200);
      expect((await test().expect(502)).body.code).toBe('AUTH_FAILED');
      expect((await settings()).body.lastTestStatus).toBe('AUTH_FAILED');
      await save(port, { username: SMTP_USER, password: SMTP_PASS }).expect(200);
      await test().expect(200);
      // cambiar otro dato sin escribir la clave: se conserva
      await save(port, {
        username: SMTP_USER,
        fromEmail: 'otro@empresa.co',
        fromName: 'Otro',
      }).expect(200);
      expect((await settings()).body.hasPassword).toBe(true);
      await test().expect(200);
      // sin usuario no hay clave; el servidor que exige AUTH ya no la recibe
      await save(port, { username: '' }).expect(200);
      expect((await settings()).body).toMatchObject({ username: null, hasPassword: false });
      await test().expect(502);
    });

    it('errores del servidor: conexión, TLS exigido y destinatario rechazado', async () => {
      smtp = fakeSmtp();
      const port = await smtp.start();
      await save(port, { requireTls: true }).expect(200);
      expect((await test().expect(502)).body.code).toBe('TLS_REQUIRED'); // el servidor no ofrece STARTTLS
      await smtp.stop();
      await save(port).expect(200);
      expect((await test().expect(502)).body.code).toBe('CONNECTION_FAILED'); // ya no escucha
      smtp = fakeSmtp({ rejectRcpt: true });
      await save(await smtp.start()).expect(200);
      expect((await test().expect(502)).body.code).toBe('REJECTED');
      expect(
        (await db.select().from(auditLogs))
          .filter((l) => l.action === 'MAIL_SETTINGS_TEST')
          .map((l) => l.result),
      ).toEqual(['TLS_REQUIRED', 'CONNECTION_FAILED', 'REJECTED']);
    });

    it('los correos del sistema usan la configuración guardada y cambian al guardar otra', async () => {
      const mailer = app.get<Mailer>(MAILER);
      await expect(mailer.send('a@empresa.co', 'sin configurar', 'x')).rejects.toThrow(
        'SMTP no configurado',
      );
      const first = fakeSmtp();
      const p1 = await first.start();
      await save(p1).expect(200);
      await mailer.send('a@empresa.co', 'Verificacion de correo', 'cuerpo');
      expect(first.received).toHaveLength(1);
      expect(first.received[0]?.data).toContain('Subject: Verificacion de correo');
      const second = fakeSmtp();
      await save(await second.start()).expect(200); // la caché se invalida al guardar
      await mailer.send('b@empresa.co', 'Otro', 'cuerpo');
      expect(second.received).toHaveLength(1);
      expect(first.received).toHaveLength(1);
      await first.stop();
      await second.stop();
    });
  },
);
