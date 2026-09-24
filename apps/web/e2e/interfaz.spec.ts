import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  newUser,
  nextPeriod,
  seedActiveAccount,
  seedAdminUser,
  seedPayroll,
  type SeedUser,
} from './support';

const LINES = [{ cCon: '100', concepto: 'Salario básico', dev: '1000.4', cant: '15' }];

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openAs(
  browser: Browser,
  u: SeedUser,
  opts: { scheme?: 'light' | 'dark'; width?: number; height?: number } = {},
) {
  const ctx = await browser.newContext({
    colorScheme: opts.scheme ?? 'light',
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 860 },
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const seriousViolations = async (page: Page) => {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ')})`);
};

test.describe('acceso: formulario claro y accesible', () => {
  test('el enlace «Saltar al contenido» es lo primero al tabular y lleva el foco al contenido', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Saltar al contenido' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#contenido')).toBeFocused();
  });

  test('cada página tiene un título propio y un único encabezado principal', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle('Ingresar - NOMFLOW');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await page.goto('/activar');
    await expect(page).toHaveTitle('Activar mi cuenta - NOMFLOW');
    await expect(page.getByRole('main')).toHaveCount(1);
  });

  test('valida junto a cada campo, marca el error, lo asocia y lleva el foco al primero inválido', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Ingresar' }).click();
    const email = page.getByLabel('Correo electrónico');
    const password = page.getByLabel('Clave', { exact: true });
    await expect(page.getByText('Escriba su correo electrónico.')).toBeVisible();
    await expect(page.getByText('Escriba su clave.')).toBeVisible();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toBeFocused();
    const describedBy = await email.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText(
      'Escriba su correo electrónico.',
    );

    await email.fill('no-es-un-correo');
    await password.fill('x');
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(
      page.getByText('Escriba un correo válido, por ejemplo nombre@empresa.com.'),
    ).toBeVisible();
    await expect(email).toBeFocused();
  });

  test('un fallo de autenticación no revela si la cuenta existe y devuelve el foco a la clave', async ({
    page,
  }) => {
    const u = newUser('real');
    await seedActiveAccount(u);
    const message = async (email: string) => {
      await page.goto('/login');
      await page.getByLabel('Correo electrónico').fill(email);
      await page.getByLabel('Clave', { exact: true }).fill('clave-incorrecta-123');
      await page.getByRole('button', { name: 'Ingresar' }).click();
      const alert = page
        .locator('p[role="alert"]')
        .filter({ hasText: /Correo o clave incorrectos/ });
      await expect(alert).toBeVisible();
      await expect(page.getByLabel('Clave', { exact: true })).toBeFocused();
      return alert.innerText();
    };
    expect(await message(u.email)).toBe(await message(`nadie-${u.email}`));
  });

  test('mientras se envía, el botón se desactiva y no se duplica la petición', async ({ page }) => {
    const u = newUser('dup');
    await seedActiveAccount(u);
    let requests = 0;
    await page.route('**/api/auth/login', async (route) => {
      requests++;
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(u.email);
    await page.getByLabel('Clave', { exact: true }).fill(u.password);
    const button = page.getByRole('button', { name: 'Ingresar' });
    await button.click();
    const busy = page.getByRole('button', { name: 'Ingresando…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/$/);
    expect(requests).toBe(1);
  });

  test('se puede mostrar y ocultar la clave con un botón accesible', async ({ page }) => {
    await page.goto('/login');
    const password = page.getByLabel('Clave', { exact: true });
    await password.fill('MiClaveSecreta-1');
    await expect(password).toHaveAttribute('type', 'password');
    const toggle = page.getByRole('button', { name: 'Mostrar clave' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Ocultar clave' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Ocultar clave' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });
});

test.describe('activación: agrupada, con ayuda y requisitos visibles', () => {
  test('explica de dónde viene cada dato y agrupa la verificación y la clave nueva', async ({
    page,
  }) => {
    await page.goto('/activar');
    const identity = page.getByRole('group', { name: 'Verifique su identidad' });
    const newPassword = page.getByRole('group', { name: 'Cree su clave nueva' });
    await expect(
      identity.getByText('Se la entregó Gestión Humana por un canal distinto al correo.'),
    ).toBeVisible();
    await expect(identity.getByText('vence a los 15 minutos y sirve una sola vez')).toBeVisible();
    await expect(newPassword.getByLabel('Clave nueva', { exact: true })).toBeVisible();
    await expect(newPassword.getByLabel('Confirmar clave nueva')).toBeVisible();
  });

  test('los requisitos de la clave se actualizan mientras se escribe y se anuncian con texto', async ({
    page,
  }) => {
    await page.goto('/activar');
    const list = page.getByRole('list', { name: 'Requisitos de la clave' });
    await expect(list).toContainText('Pendiente: Al menos 12 caracteres');
    await page.getByLabel('Clave temporal').fill('Temporal-123');
    await page.getByLabel('Clave nueva', { exact: true }).fill('corta');
    await expect(list).toContainText('Pendiente: Al menos 12 caracteres');
    await page.getByLabel('Clave nueva', { exact: true }).fill('Una-Clave-Larga-1');
    await expect(list).toContainText('Cumplido: Al menos 12 caracteres');
    await expect(list).toContainText('Cumplido: Distinta de la clave temporal');
    await expect(list).toContainText('Pendiente: La confirmación coincide con la clave nueva');
    await page.getByLabel('Confirmar clave nueva').fill('Una-Clave-Larga-1');
    await expect(list).toContainText('Cumplido: La confirmación coincide con la clave nueva');
  });

  test('muestra el error de cada campo junto a él y enfoca el primero con problema', async ({
    page,
  }) => {
    await page.goto('/activar');
    await page.getByRole('button', { name: 'Activar cuenta' }).click();
    await expect(page.getByText('Escriba el correo donde recibió el código.')).toBeVisible();
    await expect(
      page.getByText('Escriba la clave temporal que le entregó Gestión Humana.'),
    ).toBeVisible();
    await expect(
      page.getByText('Escriba el código de 8 caracteres que llegó a su correo.'),
    ).toBeVisible();
    await expect(page.getByLabel('Correo electrónico')).toBeFocused();

    await page.getByLabel('Correo electrónico').fill('x@e2e.test');
    await page.getByLabel('Clave temporal').fill('temporal');
    await page.getByLabel('Código del correo').fill('ABCDEFGH');
    await page.getByLabel('Clave nueva', { exact: true }).fill('Clave-Larga-Segura-1');
    await page.getByLabel('Confirmar clave nueva').fill('Clave-Larga-Segura-2');
    await page.getByRole('button', { name: 'Activar cuenta' }).click();
    const confirm = page.getByLabel('Confirmar clave nueva');
    await expect(confirm).toBeFocused();
    await expect(confirm).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('La confirmación no coincide con la clave nueva.')).toBeVisible();
  });

  test('el reenvío se desactiva mientras se envía y mantiene una respuesta neutra', async ({
    page,
  }) => {
    await page.route('**/api/auth/verify-email/resend', async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    await page.goto('/activar');
    await page.getByRole('button', { name: 'Reenviar código' }).click();
    await expect(page.getByText('Escriba su correo para recibir un código nuevo.')).toBeVisible();
    await expect(page.getByLabel('Correo electrónico')).toBeFocused();

    await page.getByLabel('Correo electrónico').fill('desconocido@e2e.test');
    await page.getByRole('button', { name: 'Reenviar código' }).click();
    const sending = page.getByRole('button', { name: 'Enviando…' });
    await expect(sending).toBeDisabled();
    await expect(
      page.getByText('Si la cuenta está pendiente de activación, se envió un código nuevo'),
    ).toBeVisible();
  });
});

test.describe('inicio: espacio de trabajo con lo que existe', () => {
  test('saluda por el nombre, ofrece solo funciones disponibles y explica los roles', async ({
    page,
  }) => {
    const u = newUser('mariana');
    u.name = 'MARIANA LOPEZ RUIZ';
    await seedActiveAccount(u, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
    await seedPayroll(u, await nextPeriod(), LINES);
    await login(page, u);
    await expect(page).toHaveTitle('Inicio - NOMFLOW');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hola, Mariana Lopez Ruiz');

    const tasks = page
      .getByRole('list')
      .filter({ has: page.getByRole('heading', { name: 'Mis volantes de pago' }) });
    await expect(tasks.getByText('1 volante disponible.')).toBeVisible();
    await expect(tasks.getByRole('link', { name: 'Consultar volantes' })).toBeVisible();
    await expect(tasks.getByRole('link', { name: 'Cambiar mi clave' })).toBeVisible();
    await expect(tasks.getByRole('link', { name: /administración/i })).toHaveCount(0);

    const roles = page.getByRole('region', { name: 'Mis datos y roles' });
    await expect(roles.getByText('Jefe de área', { exact: true })).toBeVisible();
    await expect(roles.getByText('Persona responsable de un área de la empresa.')).toBeVisible();
    await expect(roles.getByText('Área 10300 - Empresa GA')).toBeVisible();
    await expect(roles.getByText('Vigente desde el 1 de enero de 2020')).toBeVisible();
    await expect(
      roles.getByText('los flujos de aprobación todavía no están disponibles'),
    ).toBeVisible();
    await expect(roles.getByText('AREA_MANAGER')).toHaveCount(0);
  });

  test('no ofrece como operativos los módulos que aún no existen', async ({ page }) => {
    const u = newUser('sin');
    await seedActiveAccount(u, [{ role: 'CERTIFICATE_APPROVER' }]);
    await login(page, u);
    for (const pending of [
      /solicitud/i,
      /aprobaci/i,
      /vacaciones/i,
      /permiso/i,
      /certificado laboral/i,
      /mis documentos/i,
    ]) {
      await expect(page.getByRole('link', { name: pending }), String(pending)).toHaveCount(0);
      await expect(page.getByRole('button', { name: pending }), String(pending)).toHaveCount(0);
    }
  });

  test('sin volantes lo dice; si la consulta falla ofrece reintentar y se recupera', async ({
    page,
  }) => {
    const u = newUser('vacio');
    await seedActiveAccount(u);
    await page.route('**/api/me/payroll', (route) => route.abort());
    await login(page, u);
    await expect(page.getByText('No se pudo consultar ahora.')).toBeVisible();
    await page.unroute('**/api/me/payroll');
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Aún no hay volantes publicados para usted.')).toBeVisible();
  });

  test('un usuario sin roles recibe una explicación y no un vacío', async ({ page }) => {
    const u = newUser('norol');
    await seedActiveAccount(u);
    await login(page, u);
    await expect(page.getByText('No tiene roles asignados.')).toBeVisible();
  });
});

test.describe('navegación según el rol', () => {
  test('el empleado ve cuatro opciones y el administrador una quinta', async ({
    page,
    browser,
  }) => {
    const emp = newUser('emp');
    await seedActiveAccount(emp);
    await login(page, emp);
    const nav = page.getByRole('navigation', { name: 'Principal' });
    await expect(nav.getByRole('link')).toHaveText([
      'Inicio',
      'Mis volantes de pago',
      'Certificados de retención',
      'Mi cuenta',
    ]);
    await expect(nav.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Mis volantes de pago' }).click();
    await expect(page).toHaveURL(/\/volantes$/);
    await expect(nav.getByRole('link', { name: 'Mis volantes de pago' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const admin = await seedAdminUser('HR_ADMIN');
    const adminPage = await openAs(browser, admin);
    await expect(
      adminPage.getByRole('navigation', { name: 'Principal' }).getByRole('link'),
    ).toHaveText([
      'Inicio',
      'Mis volantes de pago',
      'Certificados de retención',
      'Mi cuenta',
      'Administración',
    ]);
    await adminPage.context().close();
  });

  test('en el teléfono el menú está plegado y se abre con un botón que informa su estado', async ({
    browser,
  }) => {
    const u = newUser('movil');
    await seedActiveAccount(u);
    const page = await openAs(browser, u, { width: 390, height: 800 });
    const nav = page.getByRole('navigation', { name: 'Principal' });
    const toggle = page.getByRole('button', { name: 'Menú' });
    await expect(nav).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(nav).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar menú' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await nav.getByRole('link', { name: 'Mi cuenta' }).click();
    await expect(page).toHaveURL(/\/cuenta\/clave$/);
    await expect(nav).toBeHidden();
    await page.context().close();
  });
});

test.describe('volantes: estados y filtros', () => {
  test('explica cada modo, muestra el filtro de año solo si hay varios y filtra', async ({
    page,
  }) => {
    const u = newUser('vol');
    await seedActiveAccount(u);
    const first = await nextPeriod();
    await seedPayroll(u, first, LINES);
    await seedPayroll(u, `${Number(first.slice(0, 4)) + 60}03`, LINES);
    await login(page, u);
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Mis volantes de pago' })
      .click();
    await expect(page).toHaveTitle('Mis volantes de pago - NOMFLOW');
    await expect(
      page.getByText('Muestra los importes originales de la liquidación.'),
    ).toBeVisible();
    await expect(
      page.getByText('Solo cambia la presentación, no la liquidación pagada.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Descargar PDF/ })).toHaveCount(2);
    await page.getByLabel('Año').selectOption(String(Number(first.slice(0, 4)) + 60));
    await expect(page.getByRole('link', { name: /Descargar PDF/ })).toHaveCount(1);
  });

  test('sin volantes muestra un estado vacío que explica cuándo aparecerán', async ({ page }) => {
    const u = newUser('vac');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/volantes');
    await expect(page.getByText('Todavía no hay volantes publicados para usted.')).toBeVisible();
    await expect(page.getByText('Cuando Gestión Humana publique una liquidación')).toBeVisible();
    await expect(page.getByLabel('Año')).toHaveCount(0);
  });

  test('si falla la carga muestra el error y permite reintentar', async ({ page }) => {
    const u = newUser('err');
    await seedActiveAccount(u);
    await login(page, u);
    await page.route('**/api/me/payroll', (route) => route.abort());
    await page.goto('/volantes');
    await expect(page.getByText('No se pudo conectar con el servidor.')).toBeVisible();
    await page.unroute('**/api/me/payroll');
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Todavía no hay volantes publicados para usted.')).toBeVisible();
  });
});

test.describe('cambio de clave dentro del espacio de trabajo', () => {
  test('confirma el cierre de otras sesiones, valida junto al campo y conserva la sesión actual', async ({
    page,
  }) => {
    const u = newUser('cambio');
    await seedActiveAccount(u);
    await login(page, u);
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Mi cuenta' })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mi cuenta');
    await page.getByLabel('Clave actual').fill('clave-actual-incorrecta');
    await page.getByLabel('Clave nueva', { exact: true }).fill('Una-Clave-Nueva-Larga-1');
    await page.getByLabel('Confirmar clave nueva').fill('Una-Clave-Nueva-Larga-1');
    await page.getByRole('button', { name: 'Cambiar clave' }).click();
    await expect(page.getByLabel('Clave actual')).toBeFocused();
    await expect(page.getByText('La clave actual es incorrecta.')).toBeVisible();

    await page.getByLabel('Clave actual').fill(u.password);
    await page.getByRole('button', { name: 'Cambiar clave' }).click();
    await expect(
      page.getByText('sus otras sesiones abiertas se cerraron; esta sigue activa.'),
    ).toBeVisible();
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  });
});

test.describe('adaptación: 320 px y ampliación de texto al 200 %', () => {
  test('ninguna pantalla desborda horizontalmente a 320 px', async ({ browser }) => {
    const u = newUser('w320');
    await seedActiveAccount(u, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
    await seedPayroll(u, await nextPeriod(), LINES);
    const admin = await seedAdminUser('HR_ADMIN');
    const pub = await browser.newContext({ viewport: { width: 320, height: 700 } });
    const anon = await pub.newPage();
    for (const path of ['http://localhost:3100/login', 'http://localhost:3100/activar']) {
      await anon.goto(path);
      expect(await noOverflow(anon), path).toBe(true);
    }
    await anon.getByRole('button', { name: /^(Ingresar|Activar cuenta)$/ }).click();
    expect(await noOverflow(anon), 'con errores').toBe(true);
    await pub.close();

    const page = await openAs(browser, u, { width: 320, height: 700 });
    for (const path of ['/', '/volantes', '/cuenta/clave']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await noOverflow(page), path).toBe(true);
    }
    await page.context().close();

    const adminPage = await openAs(browser, admin, { width: 320, height: 700 });
    for (const path of ['/admin', '/admin/empleados', '/admin/cuentas', '/admin/auditoria']) {
      await adminPage.goto(path);
      await adminPage.waitForLoadState('networkidle');
      expect(await noOverflow(adminPage), path).toBe(true);
    }
    await adminPage.context().close();
  });

  test('con el texto al 200 % el acceso, la activación y el inicio siguen siendo utilizables', async ({
    browser,
  }) => {
    const u = newUser('zoom');
    await seedActiveAccount(u);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const zoom = () => page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.goto('http://localhost:3100/login');
    await zoom();
    expect(await noOverflow(page)).toBe(true);
    await page.getByLabel('Correo electrónico').fill(u.email);
    await page.getByLabel('Clave', { exact: true }).fill(u.password);
    const button = page.getByRole('button', { name: 'Ingresar' });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 1280).toBe(true);
    await button.click();
    await expect(page).toHaveURL(/\/$/);
    await zoom();
    expect(await noOverflow(page)).toBe(true);
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    await page.goto('http://localhost:3100/activar');
    await zoom();
    expect(await noOverflow(page)).toBe(true);
    await ctx.close();
  });
});

test.describe('contraste y accesibilidad en modo claro y oscuro', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`sin violaciones graves (WCAG AA) en ${scheme === 'light' ? 'modo claro' : 'modo oscuro'}`, async ({
      browser,
    }) => {
      const u = newUser(`a11y${scheme}`);
      await seedActiveAccount(u, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
      await seedPayroll(u, await nextPeriod(), LINES);
      const admin = await seedAdminUser('HR_ADMIN');

      const anonCtx = await browser.newContext({ colorScheme: scheme });
      const anon = await anonCtx.newPage();
      await anon.goto('http://localhost:3100/login');
      await anon.getByRole('button', { name: 'Ingresar' }).click();
      await expect(anon.getByText('Escriba su clave.')).toBeVisible();
      expect(await seriousViolations(anon), 'login con errores').toEqual([]);
      await anon.goto('http://localhost:3100/activar');
      await anon.getByLabel('Clave nueva', { exact: true }).fill('corta');
      await anon.getByRole('button', { name: 'Activar cuenta' }).click();
      expect(await seriousViolations(anon), 'activar con errores').toEqual([]);
      await anonCtx.close();

      const page = await openAs(browser, u, { scheme });
      for (const path of ['/', '/volantes', '/cuenta/clave']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        expect(await seriousViolations(page), path).toEqual([]);
      }
      await page.context().close();

      const adminPage = await openAs(browser, admin, { scheme });
      for (const path of ['/admin', '/admin/empleados']) {
        await adminPage.goto(path);
        await adminPage.waitForLoadState('networkidle');
        expect(await seriousViolations(adminPage), path).toEqual([]);
      }
      await adminPage.context().close();
    });
  }
});
