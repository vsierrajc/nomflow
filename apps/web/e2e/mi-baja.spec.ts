import { expect, test, type Browser, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

/** Fecha dentro de los próximos `days` días, en formato AAAA-MM-DD. */
function soon(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function otherSession(browser: Browser, u: SeedUser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

test.describe('mi baja (autoservicio del empleado)', () => {
  test.beforeEach(async () => {
    await query(`delete from document_export_downloads`);
    await query(`delete from document_exports`);
    await query(`delete from employee_exit_schedules`);
    await query(`delete from exit_settings`);
  });

  test('sin baja programada, el empleado ve "sin novedades"', async ({ page }) => {
    const u = newUser('mibaja');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/mi-baja');
    await expect(page.getByRole('heading', { level: 1, name: 'Mi baja' })).toBeVisible();
    await expect(page.getByText('Sin novedades')).toBeVisible();
  });

  test('tras el aviso y la exportación, el empleado descarga su documentación; al vencer, deja de estar disponible', async ({
    page,
    browser,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const emp = newUser('mibaja');
    await seedActiveAccount(emp);

    await login(page, admin);
    await page.goto('/admin/bajas');
    const settings = page.getByRole('region', { name: 'Plazo de aviso' });
    await settings.getByLabel(/Días de aviso previo/).fill('90');
    await settings.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();

    const form = page.getByRole('region', { name: 'Programar baja' });
    await form.getByLabel('N_IDE del empleado').fill(emp.nIde);
    await form.getByLabel('Fecha prevista de baja').fill(soon(10));
    await form.getByLabel('Motivo').fill('Baja programada dentro del plazo de aviso.');
    await form.getByRole('button', { name: 'Programar' }).click();
    await expect(page.getByText('Baja programada.')).toBeVisible();

    await page.getByRole('button', { name: 'Revisar avisos ahora' }).click();
    await expect(page.getByText('Avisos enviados: 1.')).toBeVisible();
    await page.getByRole('button', { name: 'Generar exportaciones pendientes ahora' }).click();
    await expect(page.getByText(/^Exportaciones procesadas: \d+\.$/)).toBeVisible();

    const empPage = await otherSession(browser, emp);
    await empPage.goto('/mi-baja');
    await expect(empPage.getByText(/Estado de su exportación: (LISTO|INCOMPLETO)/)).toBeVisible({
      timeout: 15_000,
    });
    const [download] = await Promise.all([
      empPage.waitForEvent('download'),
      empPage.getByRole('link', { name: 'Descargar mi documentación (ZIP)' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('mi-documentacion.zip');

    // otro empleado, sin baja, no ve nada que descargar
    const other = newUser('mibaja');
    await seedActiveAccount(other);
    const otherPage = await otherSession(browser, other);
    await otherPage.goto('/mi-baja');
    await expect(otherPage.getByText('Sin novedades')).toBeVisible();
    await otherPage.context().close();

    // caducidad: se vence la exportación y el enlace deja de mostrarse
    await query(`update document_exports set expires_at = now() - interval '1 minute'`);
    await empPage.reload();
    await expect(
      empPage.getByText('La exportación todavía no está lista o ya venció.'),
    ).toBeVisible();
    await expect(
      empPage.getByRole('link', { name: 'Descargar mi documentación (ZIP)' }),
    ).toHaveCount(0);
    await empPage.context().close();
  });
});
