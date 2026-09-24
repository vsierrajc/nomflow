import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminCreateAccount,
  latestCode,
  newUser,
  seedActiveAccount,
  seedEmployee,
  type SeedUser,
} from './support';

const alertOf = (page: Page) => page.locator('p[role="alert"]');

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Clave', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

test.describe('acceso y sesión', () => {
  test('sin sesión, la página de inicio lleva al ingreso', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Ingresar' })).toBeVisible();
  });

  test('una clave incorrecta muestra un error accesible y no entra', async ({ page }) => {
    const u = newUser('ana');
    await seedActiveAccount(u);
    await login(page, u.email, 'clave-equivocada');
    await expect(alertOf(page)).toContainText('Correo o clave incorrectos');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('ingresa, ve su perfil y roles, y cierra sesión', async ({ page }) => {
    const u = newUser('ana');
    await seedActiveAccount(u, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
    await login(page, u.email, u.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: `Hola, ${u.name}` })).toBeVisible();
    await expect(page.getByText(u.email)).toBeVisible();
    await expect(page.getByText('Jefe de área', { exact: true })).toBeVisible();
    await expect(page.getByText('Área 10300 - Empresa GA')).toBeVisible();

    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('un empleado con contrato cancelado no puede ingresar', async ({ page }) => {
    const u = newUser('baja');
    await seedActiveAccount(u);
    const { Client } = await import('pg');
    const { TEST_DB } = await import('./support');
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    await c.query(`update employee_snapshots set est = 'C' where n_ide = $1`, [u.nIde]);
    await c.end();
    await login(page, u.email, u.password);
    await expect(alertOf(page)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('la cookie de sesión no es legible desde JavaScript', async ({ page }) => {
    const u = newUser('cook');
    await seedActiveAccount(u);
    await login(page, u.email, u.password);
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => document.cookie)).not.toContain('nf_session');
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'nf_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Strict');
  });
});

test.describe('cambio de clave', () => {
  test('valida en el cliente y cambia la clave; la anterior deja de servir', async ({ page }) => {
    const u = newUser('cambio');
    await seedActiveAccount(u);
    await login(page, u.email, u.password);
    await page.getByRole('link', { name: 'Cambiar mi clave' }).click();
    await expect(page).toHaveURL(/\/cuenta\/clave$/);

    const submit = page.getByRole('button', { name: 'Cambiar clave' });
    await page.getByLabel('Clave actual').fill(u.password);
    await page.getByLabel('Clave nueva', { exact: true }).fill('corta');
    await page.getByLabel('Confirmar clave nueva').fill('corta');
    await submit.click();
    await expect(page.getByText(/debe tener al menos 12 caracteres/)).toBeVisible();

    await page.getByLabel('Clave nueva', { exact: true }).fill(u.password);
    await page.getByLabel('Confirmar clave nueva').fill(u.password);
    await submit.click();
    await expect(page.getByText('La clave nueva debe ser distinta de la actual.')).toBeVisible();

    await page.getByLabel('Clave nueva', { exact: true }).fill('Otra-Clave-Larga-1');
    await page.getByLabel('Confirmar clave nueva').fill('No-Coincide-Larga-1');
    await submit.click();
    await expect(page.getByText('La confirmación no coincide con la clave nueva.')).toBeVisible();

    await page.getByLabel('Clave actual').fill('clave-actual-mala');
    await page.getByLabel('Clave nueva', { exact: true }).fill('Otra-Clave-Larga-1');
    await page.getByLabel('Confirmar clave nueva').fill('Otra-Clave-Larga-1');
    await submit.click();
    await expect(page.getByText('La clave actual es incorrecta.')).toBeVisible();

    await page.getByLabel('Clave actual').fill(u.password);
    await submit.click();
    await expect(page.getByRole('status')).toContainText('Clave cambiada');

    await page.goto('/');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await login(page, u.email, u.password);
    await expect(alertOf(page)).toBeVisible();
    await login(page, u.email, 'Otra-Clave-Larga-1');
    await expect(page.getByRole('heading', { name: `Hola, ${u.name}` })).toBeVisible();
  });

  test('sin sesión, la página de cambio de clave lleva al ingreso', async ({ page }) => {
    await page.goto('/cuenta/clave');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('activación de cuenta con el código del correo', () => {
  async function pendingUser(prefix: string): Promise<{ u: SeedUser; temporaryPassword: string }> {
    const u = newUser(prefix);
    await seedEmployee(u);
    const { temporaryPassword } = await adminCreateAccount(u.nIde);
    return { u, temporaryPassword };
  }

  async function fill(
    page: Page,
    u: SeedUser,
    temp: string,
    code: string,
    pw: string,
    confirm = pw,
  ) {
    await page.getByLabel('Correo electrónico').fill(u.email);
    await page.getByLabel('Clave temporal').fill(temp);
    await page.getByLabel('Código del correo').fill(code);
    await page.getByLabel('Clave nueva', { exact: true }).fill(pw);
    await page.getByLabel('Confirmar clave nueva').fill(confirm);
    await page.getByRole('button', { name: 'Activar cuenta' }).click();
  }

  test('flujo completo: alta, correo, activación e ingreso', async ({ page }) => {
    const { u, temporaryPassword } = await pendingUser('nuevo');
    const code = await latestCode(u.email);
    await page.goto('/login');
    await page.getByRole('link', { name: /Activar mi cuenta/ }).click();
    await expect(page).toHaveURL(/\/activar$/);

    const newPassword = 'Mi-Clave-Nueva-Segura-1';
    await fill(page, u, temporaryPassword, code.toLowerCase(), newPassword);
    await expect(page.getByRole('heading', { name: 'Cuenta activada' })).toBeVisible();

    await page.getByRole('link', { name: 'Ir a ingresar' }).click();
    await login(page, u.email, newPassword);
    await expect(page.getByRole('heading', { name: `Hola, ${u.name}` })).toBeVisible();
  });

  test('un código incorrecto no activa y muestra un error', async ({ page }) => {
    const { u, temporaryPassword } = await pendingUser('malcodigo');
    await latestCode(u.email);
    await page.goto('/activar');
    await fill(page, u, temporaryPassword, 'AAAAAAAA', 'Mi-Clave-Nueva-Segura-1');
    await expect(alertOf(page)).toContainText('No se pudo activar');
    await expect(page.getByRole('heading', { name: 'Activar mi cuenta' })).toBeVisible();
  });

  test('valida clave corta y confirmación distinta antes de enviar', async ({ page }) => {
    await page.goto('/activar');
    await page.getByLabel('Correo electrónico').fill('x@e2e.test');
    await page.getByLabel('Clave temporal').fill('temporal');
    await page.getByLabel('Código del correo').fill('ABCDEFGH');
    await page.getByLabel('Clave nueva', { exact: true }).fill('corta');
    await page.getByLabel('Confirmar clave nueva').fill('corta');
    await page.getByRole('button', { name: 'Activar cuenta' }).click();
    await expect(page.getByText(/debe tener al menos 12 caracteres/)).toBeVisible();
    await page.getByLabel('Clave nueva', { exact: true }).fill('Clave-Larga-Segura-1');
    await page.getByLabel('Confirmar clave nueva').fill('Clave-Larga-Segura-2');
    await page.getByRole('button', { name: 'Activar cuenta' }).click();
    await expect(page.getByText('La confirmación no coincide con la clave nueva.')).toBeVisible();
  });

  test('reenviar código: pide el correo y luego envía uno nuevo', async ({ page }) => {
    const { u } = await pendingUser('reenvio');
    const first = await latestCode(u.email);
    await page.goto('/activar');
    await page.getByRole('button', { name: 'Reenviar código' }).click();
    await expect(alertOf(page)).toContainText('Escriba su correo');
    await page.getByLabel('Correo electrónico').fill(u.email);
    await page.getByRole('button', { name: 'Reenviar código' }).click();
    await expect(page.getByRole('status')).toContainText('se envió un código nuevo');
    await expect.poll(async () => latestCode(u.email), { timeout: 10_000 }).not.toBe(first);
  });
});

test.describe('seguridad, accesibilidad y adaptación', () => {
  test('cabeceras de seguridad y CSP en la respuesta', async ({ request }) => {
    const res = await request.get('/login');
    const h = res.headers();
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toContain("connect-src 'self'");
  });

  test('sin violaciones graves de accesibilidad en ingreso, activación e inicio', async ({
    page,
  }) => {
    for (const path of ['/login', '/activar']) {
      await page.goto(path);
      await expect(page.getByRole('heading').first()).toBeVisible();
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map((v) => `${v.id}: ${v.help}`),
        path,
      ).toEqual([]);
    }
    const u = newUser('a11y');
    await seedActiveAccount(u, [{ role: 'EMPLOYEE' }]);
    await login(page, u.email, u.password);
    await expect(page.getByRole('heading', { name: /Hola,/ })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });

  test('en pantalla de teléfono no hay desplazamiento horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ['/login', '/activar']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow, path).toBe(false);
    }
  });

  test('respeta el modo oscuro del sistema', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto('http://localhost:3100/login');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(14, 20, 26)');
    await ctx.close();
  });

  test('todos los campos se pueden operar solo con teclado', async ({ page }) => {
    await page.goto('/login');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Correo electrónico')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Clave', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Mostrar clave' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Ingresar' })).toBeFocused();
  });
});
