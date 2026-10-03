import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { newUser, query, seedActiveAccount, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

const serious = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);

/** Lo que haría el teléfono con la clave manual que muestra la pantalla. */
const appCode = (manualKey: string, steps = 0) =>
  new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(manualKey.replace(/\s/g, '')),
  }).generate({ timestamp: Date.now() + steps * 30_000 });

test.describe('verificación en dos pasos con app autenticadora (TOTP)', () => {
  test('activa con QR, ingresa con la app y con un código de respaldo, y vuelve al correo', async ({
    page,
  }) => {
    const u = newUser('totp');
    await seedActiveAccount(u);
    await login(page, u);
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole('link', { name: 'Mi cuenta' }).click();
    await page.getByRole('link', { name: 'Verificación en dos pasos' }).click();
    await page.getByRole('button', { name: 'Configurar app autenticadora' }).click();
    await page.getByRole('button', { name: 'Mostrar código QR' }).click();

    const qr = page.getByRole('img', { name: /Código QR para añadir NOMFLOW/ });
    await expect(qr).toBeVisible();
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await page.getByText('¿No puede escanear?').click();
    const manualKey = (await page.getByLabel('Clave de configuración manual').textContent()) ?? '';
    expect(manualKey.replace(/\s/g, '')).toMatch(/^[A-Z2-7]{32}$/);
    expect(await serious(page)).toEqual([]);

    await page.getByLabel('Código de la app').fill('000000');
    await page.getByRole('button', { name: 'Activar app autenticadora' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'incorrecto o ya se usó' }),
    ).toBeVisible();
    await page.getByLabel('Código de la app').fill(appCode(manualKey));
    await page.getByRole('button', { name: 'Activar app autenticadora' }).click();

    // Códigos de respaldo: se ven una vez y hay que confirmar que se guardaron.
    await expect(
      page.getByRole('heading', { name: 'Guarde sus códigos de respaldo' }),
    ).toBeVisible();
    const codes = await page
      .getByRole('list', { name: 'Lista de códigos de respaldo' })
      .locator('code')
      .allTextContents();
    expect(codes).toHaveLength(10);
    expect(await serious(page)).toEqual([]);
    const done = page.getByRole('button', { name: 'Terminar' });
    await expect(done).toBeDisabled();
    await page.getByLabel('Ya guardé mis códigos de respaldo').check();
    await done.click();
    await expect(page.getByText('Estado: activada con app autenticadora')).toBeVisible();
    await expect(page.getByText('Le quedan 10 códigos de respaldo')).toBeVisible();
    expect(
      await query(`select two_factor_method from accounts where email = $1`, [u.email]),
    ).toEqual([{ two_factor_method: 'TOTP' }]);
    expect(await serious(page)).toEqual([]);

    // Ingreso con la app: el código del paso siguiente (el actual se usó al activar).
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await login(page, u);
    await expect(page.getByText('Abra su app autenticadora')).toBeVisible();
    await page.getByLabel('Código de verificación').fill('123456');
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'incorrecto, venció o ya se usó' }),
    ).toBeVisible();
    await page.getByLabel('Código de verificación').fill(appCode(manualKey, 1));
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/$/);

    // Ingreso con un código de respaldo.
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await login(page, u);
    await page.getByLabel('Código de verificación').fill(codes[0] ?? '');
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/$/);

    // Desactivar con clave y otro código de respaldo: vuelve al método por correo.
    await page.getByRole('link', { name: 'Mi cuenta' }).click();
    await page.getByRole('link', { name: 'Verificación en dos pasos' }).click();
    await expect(page.getByText('Le quedan 9 códigos de respaldo')).toBeVisible();
    const disable = page.getByRole('region', { name: 'Desactivar la app autenticadora' });
    await disable.getByLabel('Clave (para desactivar la app)').fill(u.password);
    await disable.getByLabel('Código actual de la app').fill(codes[1] ?? '');
    await disable.getByRole('button', { name: 'Desactivar app autenticadora' }).click();
    await expect(page.getByText('App autenticadora desactivada.')).toBeVisible();
    await expect(page.getByText('Estado: activada', { exact: true })).toBeVisible();
    expect(
      await query(`select two_factor_method from accounts where email = $1`, [u.email]),
    ).toEqual([{ two_factor_method: 'EMAIL' }]);
  });
});
