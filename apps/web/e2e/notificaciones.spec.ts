import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('notificaciones del flujo', () => {
  test.beforeEach(async () => {
    await query(`delete from notification_log`);
    await query(`delete from notification_settings`);
  });

  test('el administrador ve la configuración por omisión, la valida y la guarda', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    await login(page, admin);
    await page.goto('/admin/notificaciones');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Notificaciones del flujo' }),
    ).toBeVisible();
    const form = page.getByRole('region', { name: 'Configuración de avisos' });
    await expect(form.getByLabel(/Recordar tras/)).toHaveValue('3');
    await expect(form.getByLabel(/Avisar al jefe de área/)).toBeChecked();
    await expect(page.getByText('Todavía no se ha enviado ninguno.')).toBeVisible();

    await form.getByLabel(/Recordar tras/).fill('99');
    await form.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'Revise los datos' })).toBeVisible();

    await form.getByLabel(/Recordar tras/).fill('5');
    await form.getByLabel(/Avisar al empleado/).uncheck();
    await form.getByLabel(/Dirección de NOMFLOW/).fill('https://nomflow.gr4l.co');
    await form.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();
    await page.reload();
    const again = page.getByRole('region', { name: 'Configuración de avisos' });
    await expect(again.getByLabel(/Recordar tras/)).toHaveValue('5');
    await expect(again.getByLabel(/Avisar al empleado/)).not.toBeChecked();
    await expect(again.getByLabel(/Dirección de NOMFLOW/)).toHaveValue('https://nomflow.gr4l.co');
  });

  test('un empleado no ve la configuración', async ({ page }) => {
    const u = newUser('notif');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/admin/notificaciones');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });
});
