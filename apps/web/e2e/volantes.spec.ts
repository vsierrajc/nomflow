import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { newUser, nextPeriod, seedActiveAccount, seedPayroll } from './support';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Clave', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

const LINES = [
  { cCon: '100', concepto: 'Salario básico', dev: '1000.4', cant: '15' },
  { cCon: '200', concepto: 'Aporte salud', ded: '100.2' },
];

test.describe('volantes de pago', () => {
  test('sin sesión, la página lleva al ingreso', async ({ page }) => {
    await page.goto('/volantes');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('sin volantes publicados muestra un mensaje claro', async ({ page }) => {
    const u = newUser('vacio');
    await seedActiveAccount(u);
    await login(page, u.email, u.password);
    await page.getByRole('link', { name: 'Mis volantes de pago' }).click();
    await expect(page.getByRole('heading', { name: 'Mis volantes de pago' })).toBeVisible();
    await expect(page.getByText('Todavía no hay volantes publicados para usted.')).toBeVisible();
  });

  test('lista, cambia de modo y descarga un PDF válido', async ({ page }) => {
    const u = newUser('vol');
    await seedActiveAccount(u);
    const per = await nextPeriod();
    await seedPayroll(u, per, LINES);
    await login(page, u.email, u.password);
    await page.getByRole('link', { name: 'Mis volantes de pago' }).click();

    await expect(page.getByRole('radio', { name: /Entero superior/ })).toBeChecked();
    const link = page.getByRole('link', { name: /Descargar PDF/ });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute(
      'href',
      new RegExp(`/api/me/payroll/${per}/1/1/pdf\\?mode=ENTERO_SUPERIOR$`),
    );

    await page.getByRole('radio', { name: /Sin ajuste/ }).check();
    await expect(link).toHaveAttribute('href', /mode=SIN_AJUSTE$/);

    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe(`volante-${per}-q1.pdf`);
    const path = await download.path();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1500);
    expect(bytes.subarray(-8).toString()).toContain('%%EOF');
  });

  test('no se puede descargar el volante de otra persona', async ({ page }) => {
    const owner = newUser('duenio');
    const intruder = newUser('intruso');
    await seedActiveAccount(owner);
    await seedActiveAccount(intruder);
    const per = await nextPeriod();
    await seedPayroll(owner, per, LINES);
    await login(page, intruder.email, intruder.password);
    const res = await page.request.get(`/api/me/payroll/${per}/1/1/pdf?mode=SIN_AJUSTE`);
    expect(res.status()).toBe(404);
    const list = await page.request.get('/api/me/payroll');
    expect((await list.json()).vouchers).toEqual([]);
  });

  test('sin violaciones graves de accesibilidad', async ({ page }) => {
    const u = newUser('a11yv');
    await seedActiveAccount(u);
    await seedPayroll(u, await nextPeriod(), LINES);
    await login(page, u.email, u.password);
    await page.goto('/volantes');
    await expect(page.getByRole('link', { name: /Descargar PDF/ })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
