import { expect, test, type Page } from '@playwright/test';
import { query, seedAdminUser, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('festivos: años por vigilar', () => {
  test('muestra el año actual, el siguiente y un año que falló, sin consultar nada', async ({
    page,
  }) => {
    const now = new Date().getUTCFullYear();
    await query(`delete from holiday_year_loads`);
    await query(`delete from holiday_api_settings`);
    await query(
      `insert into holiday_year_loads (year, last_status, failures) values ($1, 'UNAVAILABLE', 2)`,
      [now + 3],
    );
    const admin = await seedAdminUser('HR_ADMIN');
    await login(page, admin);
    await page.goto('/admin/festivos');
    const region = page.getByRole('region', { name: 'Calendarios por año' });
    await expect(region.getByRole('heading', { name: 'Calendarios por año' })).toBeVisible();
    const table = region.getByRole('region', { name: 'Estado de los años' });
    await expect(table).toContainText(String(now));
    await expect(table).toContainText(String(now + 1));
    await expect(table).toContainText('Año actual o siguiente');
    const failed = table.getByRole('row', { name: new RegExp(String(now + 3)) });
    await expect(failed).toContainText('Un cálculo lo pidió');
    await expect(failed).toContainText('2 fallos seguidos');
    // sin el servicio configurado no se puede reintentar, y se dice por qué
    await expect(table.getByRole('button', { name: /^Cargar ahora/ }).first()).toBeDisabled();
    await expect(region.getByText('Configure el servicio (URL y clave)')).toBeVisible();
    await query(`delete from holiday_year_loads`);
  });
});
