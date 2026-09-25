import { expect, test, type Page } from '@playwright/test';
import { query, seedActiveAccount, seedAdminUser, newUser, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('salud del sistema', () => {
  test.beforeEach(async () => {
    await query(`delete from health_alerts`);
    await query(`delete from health_settings`);
  });

  test('el administrador ve el estado, cambia umbrales y aparece el aviso en la administración', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    await login(page, admin);
    await page.goto('/admin/salud');
    await expect(page.getByRole('heading', { level: 1, name: 'Salud del sistema' })).toBeVisible();
    await expect(page.getByTestId('check-database')).toContainText('En orden');
    await expect(page.getByTestId('check-storage_space')).toBeVisible();

    const form = page.getByRole('region', { name: 'Umbrales' });
    // crítico mayor que aviso: la API lo rechaza y el mensaje lo explica
    await form.getByLabel('Espacio libre: aviso (%)').fill('20');
    await form.getByLabel('Espacio libre: crítico (%)').fill('30');
    await form.getByRole('button', { name: 'Guardar umbrales' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'Revise los umbrales' })).toBeVisible();

    // umbrales altos: cualquier espacio real queda en aviso o crítico y se muestra el aviso
    await form.getByLabel('Espacio libre: aviso (%)').fill('95');
    await form.getByLabel('Espacio libre: crítico (%)').fill('90');
    await form.getByLabel('Correos adicionales').fill('ti@example.com');
    await form.getByRole('button', { name: 'Guardar umbrales' }).click();
    await expect(page.getByText('Umbrales guardados.')).toBeVisible();
    await page.getByRole('button', { name: 'Revisar ahora' }).click();
    await expect(page.getByText('Verificación terminada.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('check-storage_space')).not.toContainText('En orden');

    await page.goto('/admin');
    await expect(page.getByTestId('health-banner')).toContainText('Ver salud del sistema');
    await page.goto('/admin/salud');
    await expect(
      page.getByRole('region', { name: 'Historial de alertas' }).getByRole('row').nth(1),
    ).toContainText('Abierta');
  });

  test('un empleado no ve la salud del sistema', async ({ page }) => {
    const u = newUser('salud');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/admin/salud');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });
});
