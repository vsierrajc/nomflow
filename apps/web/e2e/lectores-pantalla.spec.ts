import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { newUser, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

/*
 * Lo que recibe un lector de pantalla es el árbol de accesibilidad del navegador: roles, nombres,
 * descripciones, puntos de referencia y regiones vivas. Estas pruebas lo verifican de forma
 * automática; NO sustituyen una revisión manual con NVDA, JAWS, VoiceOver u Orca (ver
 * docs/design/rediseno-ui.md).
 */

async function openAs(browser: Browser, u: SeedUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

const findings = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page })
    .withTags(['best-practice', 'wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(' ')}`);
};

const EMPLOYEE_PAGES = [
  '/',
  '/bandeja',
  '/volantes',
  '/vacaciones',
  '/permisos',
  '/certificado-laboral',
  '/retenciones',
  '/mi-baja',
  '/cuenta/clave',
  '/cuenta/seguridad',
  '/cuenta/apariencia',
  '/cuenta/suplencias',
  '/cuenta/firma',
];

test.describe('lectores de pantalla: estructura y nombres', () => {
  test('cada pantalla del empleado tiene puntos de referencia, un h1 y encabezados sin saltos', async ({
    browser,
  }) => {
    const u = newUser('lector');
    await seedActiveAccount(u);
    const page = await openAs(browser, u);
    expect(await page.locator('html').getAttribute('lang')).toBe('es');

    for (const path of EMPLOYEE_PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('banner'), path).toHaveCount(1);
      await expect(page.getByRole('main'), path).toHaveCount(1);
      await expect(page.getByRole('contentinfo'), path).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: 'Principal' }), path).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveCount(1);

      // los niveles de encabezado nunca saltan (h1 → h3 sin h2 desorienta a quien navega por encabezados)
      const levels = await page
        .getByRole('heading')
        .evaluateAll((hs) => hs.map((h) => Number(h.tagName.slice(1)) || 0));
      levels.forEach((l, i) => {
        if (i > 0)
          expect(l - (levels[i - 1] ?? 0), `${path}: encabezados ${levels}`).toBeLessThanOrEqual(1);
      });
    }
    await page.context().close();
  });

  test('«Saltar al contenido» es lo primero y la página actual se marca en el menú', async ({
    browser,
  }) => {
    const u = newUser('lector2');
    await seedActiveAccount(u);
    const page = await openAs(browser, u);
    await page.goto('/volantes');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Saltar al contenido' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await expect(
      page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Mis volantes de pago' }),
    ).toHaveAttribute('aria-current', 'page');
    await page.context().close();
  });

  test('sin hallazgos de accesibilidad (WCAG 2.1 AA y buenas prácticas) en las pantallas del empleado', async ({
    browser,
  }) => {
    const u = newUser('lector3');
    await seedActiveAccount(u);
    const page = await openAs(browser, u);
    for (const path of EMPLOYEE_PAGES) {
      await page.goto(path);
      expect(await findings(page), path).toEqual([]);
    }
    await page.context().close();
  });

  test('sin hallazgos en las pantallas públicas y en las del administrador', async ({
    browser,
  }) => {
    const anon = await (await browser.newContext()).newPage();
    for (const path of ['/login', '/activar']) {
      await anon.goto(`http://localhost:3100${path}`);
      expect(await findings(anon), path).toEqual([]);
    }
    await anon.context().close();

    const admin = await seedAdminUser('HR_ADMIN');
    const page = await openAs(browser, admin);
    for (const path of [
      '/admin',
      '/admin/empleados',
      '/admin/certificados-emitidos',
      '/admin/registros',
      '/admin/retencion',
      '/admin/suplencias',
    ]) {
      await page.goto(path);
      expect(await findings(page), path).toEqual([]);
    }
    await page.context().close();
  });
});

test.describe('lectores de pantalla: formularios y avisos', () => {
  test('los errores del login se anuncian: campos inválidos con su mensaje como descripción', async ({
    browser,
  }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('http://localhost:3100/login');
    await page.getByRole('button', { name: 'Ingresar' }).click();

    const email = page.getByRole('textbox', { name: 'Correo electrónico' });
    const clave = page.getByRole('textbox', { name: 'Clave' });
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(clave).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toHaveAccessibleDescription(/Escriba su correo electrónico/);
    await expect(clave).toHaveAccessibleDescription(/Escriba su clave/);
    await page.context().close();
  });

  test('el botón de mostrar la clave informa su estado y cambia de nombre', async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('http://localhost:3100/login');
    const toggle = page.getByRole('button', { name: 'Mostrar clave' });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Ocultar clave' })).toBeVisible();
    await page.context().close();
  });

  test('el conmutador de tema es un grupo de opciones con nombre y anuncia el cambio', async ({
    browser,
  }) => {
    const u = newUser('lector4');
    await seedActiveAccount(u);
    const page = await openAs(browser, u);
    await page.goto('/cuenta/apariencia');
    await expect(page.getByRole('group', { name: 'Tema de la interfaz' })).toMatchAriaSnapshot(`
      - group "Tema de la interfaz":
        - radio "Automático (según su dispositivo)" [checked]
        - radio "Claro"
        - radio "Oscuro"
    `);
    await page.getByRole('radio', { name: 'Oscuro' }).focus();
    await page.getByRole('radio', { name: 'Oscuro' }).check();
    await expect(page.getByRole('status')).toContainText('Tema oscuro activado.');
    await page.context().close();
  });
});
