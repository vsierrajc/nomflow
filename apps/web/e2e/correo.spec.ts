import { expect, test, type Page } from '@playwright/test';
import { createServer, type Socket } from 'node:net';
import { newUser, query, seedAdminUser, seedActiveAccount, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** SMTP mínimo, sin TLS: guarda lo recibido y contesta 502 a STARTTLS como un Postfix sin TLS. */
function fakeSmtp() {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    let data = false;
    let buf = '';
    s.write('220 fake ESMTP\r\n');
    s.on('data', (c) => {
      buf += c.toString('utf8');
      if (data) {
        if (!buf.includes('\r\n.\r\n')) return;
        received.push(buf.slice(0, buf.indexOf('\r\n.\r\n')));
        buf = '';
        data = false;
        return void s.write('250 OK\r\n');
      }
      while (buf.includes('\r\n')) {
        const line = buf.slice(0, buf.indexOf('\r\n')).toUpperCase();
        buf = buf.slice(buf.indexOf('\r\n') + 2);
        if (line.startsWith('EHLO') || line.startsWith('HELO')) s.write('250 fake\r\n');
        else if (line === 'STARTTLS') s.write('502 5.5.1 Error: command not implemented\r\n');
        else if (line === 'DATA') {
          data = true;
          s.write('354 fin con .\r\n');
        } else if (line === 'QUIT') {
          s.write('221 bye\r\n');
          s.end();
        } else s.write('250 OK\r\n');
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
        for (const s of sockets) s.destroy();
      }),
  };
}

test.describe('configuración del correo saliente', () => {
  test('el administrador configura el servidor, prueba el envío y entiende los errores', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const smtp = fakeSmtp();
    const port = await smtp.start();
    await query(`delete from mail_settings`);
    try {
      await login(page, admin);
      await page.goto('/admin/correo');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Correo saliente (SMTP)' }),
      ).toBeVisible();
      const status = page.getByRole('region', { name: 'Estado del correo' });
      await expect(status.getByText(/variables de entorno del servidor/)).toBeVisible();

      const cfg = page.getByRole('region', { name: 'Configuración del servidor' });
      const fill = async (host: string, p: number, requireTls: boolean) => {
        await cfg.getByLabel('Servidor SMTP (nombre o dirección IP)').fill(host);
        await cfg.getByLabel('Puerto', { exact: true }).fill(String(p));
        const box = cfg.getByLabel(/Exigir STARTTLS/);
        if ((await box.isChecked()) !== requireTls) await box.setChecked(requireTls);
        await cfg.getByLabel('Correo de origen (dirección From)').fill('nomflow@gr4l.co');
        await cfg.getByLabel('Nombre del remitente').fill('NOMFLOW');
        await cfg.getByRole('button', { name: 'Guardar configuración' }).click();
      };

      // datos inválidos
      await fill('host con espacios', port, false);
      await expect(page.locator('p[role="alert"]', { hasText: 'Revise los datos' })).toBeVisible();

      // con STARTTLS exigido y un servidor sin TLS: el mensaje explica qué hacer
      await fill('127.0.0.1', port, true);
      await expect(page.getByText('Configuración guardada.')).toBeVisible();
      const test = page.getByRole('region', { name: 'Correo de prueba' });
      await test.getByRole('button', { name: 'Enviar correo de prueba' }).click();
      await expect(
        page.locator('p[role="alert"]', { hasText: 'desmarque «Exigir STARTTLS»' }),
      ).toBeVisible();
      await expect(status.getByText(/El servidor no admite TLS/)).toBeVisible();

      // servidor interno sin TLS: se desmarca y funciona
      await fill('127.0.0.1', port, false);
      await expect(page.getByText('Configuración guardada.')).toBeVisible();
      await test.getByLabel('Enviar la prueba a').fill('destino@empresa.co');
      await test.getByRole('button', { name: 'Enviar correo de prueba' }).click();
      await expect(page.getByText('Correo de prueba enviado a destino@empresa.co.')).toBeVisible();
      expect(smtp.received).toHaveLength(1);
      expect(smtp.received[0]).toContain('Subject: Prueba de correo de NOMFLOW');
      expect(smtp.received[0]).toContain('From: NOMFLOW <nomflow@gr4l.co>');
      await expect(status.getByText(/Última prueba: Correcta/)).toBeVisible();

      // la clave no vuelve al navegador
      const secret = 'clave-smtp-e2e-SECRETA';
      await cfg.getByLabel(/^Usuario/).fill('notificador');
      await cfg.getByLabel('Clave del usuario').fill(secret);
      await cfg.getByRole('button', { name: 'Guardar configuración' }).click();
      await expect(page.getByText('Configuración guardada.')).toBeVisible();
      await expect(page.getByText('Ya hay una clave guardada.')).toBeVisible();
      await expect(cfg.getByLabel('Clave del usuario')).toHaveValue('');
      expect(await page.content()).not.toContain(secret);
    } finally {
      // Restaura los valores de Mailpit por la propia pantalla (así se invalida la caché del envío).
      await page.goto('/admin/correo');
      const cfg = page.getByRole('region', { name: 'Configuración del servidor' });
      await cfg.getByLabel('Servidor SMTP (nombre o dirección IP)').fill('localhost');
      await cfg.getByLabel('Puerto', { exact: true }).fill('1025');
      const box = cfg.getByLabel(/Exigir STARTTLS/);
      if (await box.isChecked()) await box.setChecked(false);
      await cfg.getByLabel(/^Usuario/).fill('');
      const clear = cfg.getByLabel('Borrar la clave guardada');
      if (await clear.count()) await clear.check();
      await cfg.getByLabel('Correo de origen (dirección From)').fill('no-reply@nomflow.local');
      await cfg.getByLabel('Nombre del remitente').fill('NOMFLOW');
      await cfg.getByRole('button', { name: 'Guardar configuración' }).click();
      await expect(page.getByText('Configuración guardada.')).toBeVisible();
      await smtp.stop();
    }
  });

  test('un empleado no ve la configuración del correo', async ({ page }) => {
    const u = newUser('correo');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/admin/correo');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });
});
