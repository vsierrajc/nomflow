import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { newUser, seedActiveAccount, type SeedUser } from './support';

const DARK_BG = 'rgb(14, 20, 26)'; // --color-bg del modo oscuro
const LIGHT_BG = 'rgb(245, 247, 250)'; // --color-bg del modo claro

async function openAs(browser: Browser, u: SeedUser, scheme: 'light' | 'dark') {
  const ctx = await browser.newContext({ colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const serious = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ')})`);

test.describe('conmutador de tema', () => {
  test('la persona elige el tema desde Mi cuenta; se recuerda y rige en todas las pantallas', async ({
    browser,
  }) => {
    const u = newUser('tema');
    await seedActiveAccount(u);
    const page = await openAs(browser, u, 'light');

    // por omisión sigue al dispositivo (aquí, claro) y no fuerza nada
    expect(await theme(page)).toBeNull();
    expect(await bg(page)).toBe(LIGHT_BG);

    await page.getByRole('link', { name: 'Mi cuenta' }).click();
    await page
      .getByRole('navigation', { name: 'Mi cuenta' })
      .getByRole('link', { name: 'Apariencia' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Apariencia' })).toBeVisible();
    const group = page.getByRole('group', { name: 'Tema de la interfaz' });
    await expect(group.getByRole('radio', { name: /^Automático/ })).toBeChecked();

    await group.getByRole('radio', { name: 'Oscuro' }).check();
    await expect(page.getByRole('status')).toContainText('Tema oscuro activado.');
    expect(await theme(page)).toBe('dark');
    expect(await bg(page)).toBe(DARK_BG);

    // se recuerda: otra pantalla y una recarga ya salen oscuras, sin esperar a que cargue React
    await page.goto('/volantes');
    expect(await theme(page)).toBe('dark');
    expect(await bg(page)).toBe(DARK_BG);
    await page.reload({ waitUntil: 'domcontentloaded' });
    expect(await theme(page)).toBe('dark');

    // Claro gana sobre un dispositivo oscuro y Automático lo devuelve al dispositivo
    await page.context().close();
    const dark = await openAs(browser, u, 'dark');
    expect(await bg(dark)).toBe(DARK_BG); // automático sigue al dispositivo
    await dark.goto('/cuenta/apariencia');
    const g2 = dark.getByRole('group', { name: 'Tema de la interfaz' });
    await g2.getByRole('radio', { name: 'Claro' }).check();
    await expect(dark.getByRole('status')).toContainText('Tema claro activado.');
    expect(await theme(dark)).toBe('light');
    expect(await bg(dark)).toBe(LIGHT_BG);
    await g2.getByRole('radio', { name: /^Automático/ }).check();
    await expect(dark.getByRole('status')).toContainText('Tema automático');
    expect(await theme(dark)).toBeNull();
    expect(await bg(dark)).toBe(DARK_BG);
    await dark.context().close();
  });

  test('el login también respeta el tema elegido y un valor ajeno se ignora', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('nomflow-theme', 'dark'));
    await page.goto('http://localhost:3100/login');
    expect(await theme(page)).toBe('dark');
    expect(await bg(page)).toBe(DARK_BG);

    await page.addInitScript(() => localStorage.setItem('nomflow-theme', '<script>'));
    await page.reload();
    expect(await theme(page)).toBeNull();
    await ctx.close();
  });

  for (const forced of ['light', 'dark'] as const) {
    test(`contraste suficiente (WCAG AA) con el tema ${forced === 'light' ? 'claro' : 'oscuro'} elegido contra un dispositivo ${forced === 'light' ? 'oscuro' : 'claro'}`, async ({
      browser,
    }) => {
      const u = newUser(`tema${forced}`);
      await seedActiveAccount(u);
      const page = await openAs(browser, u, forced === 'light' ? 'dark' : 'light');
      await page.goto('/cuenta/apariencia');
      await page
        .getByRole('group', { name: 'Tema de la interfaz' })
        .getByRole('radio', { name: forced === 'light' ? 'Claro' : 'Oscuro' })
        .check();
      expect(await theme(page)).toBe(forced);
      for (const path of ['/cuenta/apariencia', '/', '/volantes', '/cuenta/clave']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        expect(await serious(page), path).toEqual([]);
      }
      await page.context().close();
    });
  }
});
