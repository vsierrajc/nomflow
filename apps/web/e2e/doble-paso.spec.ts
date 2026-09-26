import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  newTwoFactorCode,
  newUser,
  query,
  seedActiveAccount,
  seedAdminUser,
  seedEmployee,
  type SeedUser,
} from './support';

async function login(page: Page, u: SeedUser, password = u.password) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

/** Ingresa como administrador y espera a tener sesión antes de seguir. */
async function loginAdmin(page: Page) {
  await login(page, await seedAdminUser('HR_ADMIN'));
  await expect(page).toHaveURL(/\/$/);
}

async function session(browser: Browser, u: SeedUser, password = u.password): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3100/login');
  await login(page, u, password);
  await expect(page).toHaveURL(/\/$/);
  return page;
}

const serious = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.help}`);

test.describe('verificación en dos pasos (opcional, por correo)', () => {
  test('el empleado la activa, ingresa con código y la desactiva con su clave', async ({
    page,
  }) => {
    const u = newUser('dospasos');
    await seedActiveAccount(u);
    await login(page, u);
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole('link', { name: 'Mi cuenta' }).click();
    await page.getByRole('link', { name: 'Verificación en dos pasos' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Verificación en dos pasos' }),
    ).toBeVisible();
    await expect(page.getByText('Estado: no activada')).toBeVisible();
    expect(await serious(page)).toEqual([]);

    await page.getByRole('button', { name: 'Enviarme un código' }).click();
    await expect(page.getByText(`Le enviamos un código de 6 dígitos a ${u.email}.`)).toBeVisible();
    const code = await newTwoFactorCode(u.email);
    await page.getByLabel('Código recibido por correo').fill('000000');
    await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'incorrecto, venció o ya se usó' }),
    ).toBeVisible();
    await page.getByLabel('Código recibido por correo').fill(code);
    await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click();
    await expect(page.getByText('Verificación en dos pasos activada.')).toBeVisible();
    await expect(page.getByText('Estado: activada')).toBeVisible();
    expect(
      await query(`select two_factor_enabled from accounts where email = $1`, [u.email]),
    ).toEqual([{ two_factor_enabled: true }]);

    // cierra sesión y vuelve a ingresar: la clave sola no basta
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, u);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Verificación en dos pasos' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/); // sin sesión todavía
    expect(await serious(page)).toEqual([]);
    await page.getByLabel('Código de verificación').fill('123456');
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'incorrecto, venció o ya se usó' }),
    ).toBeVisible();
    const loginCode = await newTwoFactorCode(u.email, [code]);
    await page.getByLabel('Código de verificación').fill(loginCode);
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: `Hola, ${u.name}` })).toBeVisible();

    // volver a ingresar desde el segundo paso
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, u);
    await page.getByRole('button', { name: 'Volver a ingresar' }).click();
    await expect(page.getByLabel('Correo electrónico')).toBeVisible();

    // desactivar exige la clave (cada ingreso nuevo anula el código anterior)
    const abandoned = await newTwoFactorCode(u.email, [code, loginCode]);
    await login(page, u);
    const again = await newTwoFactorCode(u.email, [code, loginCode, abandoned]);
    await page.getByLabel('Código de verificación').fill(again);
    await page.getByRole('button', { name: 'Verificar' }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/cuenta/seguridad');
    await page.getByLabel('Clave (para desactivarla)').fill('clave-incorrecta-123');
    await page.getByRole('button', { name: 'Desactivar verificación en dos pasos' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'La clave es incorrecta' }),
    ).toBeVisible();
    await page.getByLabel('Clave (para desactivarla)').fill(u.password);
    await page.getByRole('button', { name: 'Desactivar verificación en dos pasos' }).click();
    await expect(page.getByText('Verificación en dos pasos desactivada.')).toBeVisible();
    expect(
      await query(`select two_factor_enabled from accounts where email = $1`, [u.email]),
    ).toEqual([{ two_factor_enabled: false }]);
  });
});

test.describe('cuenta de acceso en la gestión de empleados', () => {
  async function openAccount(page: Page, u: SeedUser) {
    await page.goto('/admin/empleados');
    await page.getByLabel('Buscar por nombre, identificación o correo').fill(u.nIde);
    const row = page.getByRole('row', { name: new RegExp(u.nIde) });
    await row.getByRole('button', { name: /^Ver / }).click();
    return page.getByRole('region', { name: 'Cuenta de acceso' });
  }

  test('restablecer la clave desde el empleado genera una temporal, la muestra y pide confirmación', async ({
    page,
  }) => {
    await loginAdmin(page);
    const u = newUser('restablece');
    await seedActiveAccount(u);
    const section = await openAccount(page, u);
    await expect(section.getByText('Activa', { exact: true })).toBeVisible();
    await section.getByRole('button', { name: 'Restablecer clave (generar una temporal)' }).click();
    // pide confirmación: cancelar no cambia nada
    await section.getByRole('button', { name: 'Cancelar' }).click();
    await expect(section.getByTestId('temporary-password')).toHaveCount(0);
    await section.getByRole('button', { name: 'Restablecer clave (generar una temporal)' }).click();
    await section.getByRole('button', { name: 'Sí, restablecer y mostrar la clave' }).click();
    await expect(page.getByText(/Clave restablecida\./)).toBeVisible();
    const temp = (await section.getByTestId('temporary-password').textContent()) ?? '';
    expect(temp.length).toBeGreaterThanOrEqual(12);
    await expect(section.getByRole('button', { name: 'Copiar clave' })).toBeVisible();
    await expect(section.getByText('Pendiente de activación')).toBeVisible();
    // con la clave temporal el empleado no entra directo: debe activar la cuenta
    await page.request
      .post('/api/auth/login', { data: { email: u.email, password: temp } })
      .then((r) => expect(r.status()).toBe(401));
    // activar ahora con esa misma clave (sin esperar el código del correo): ya puede ingresar
    await section
      .getByRole('button', { name: 'Activar la cuenta ahora con esta clave (sin código)' })
      .click();
    await expect(page.getByText(/La cuenta quedó activa/)).toBeVisible();
    await expect(section.getByText('Activa', { exact: true })).toBeVisible();
    await page.request
      .post('/api/auth/login', { data: { email: u.email, password: temp } })
      .then((r) => expect(r.status()).toBe(200));
  });

  test('el administrador asigna una clave a una cuenta activa y el empleado ingresa con ella', async ({
    page,
    browser,
  }) => {
    await loginAdmin(page);
    const u = newUser('asigna');
    await seedActiveAccount(u);
    const section = await openAccount(page, u);
    await expect(section.getByText(u.email, { exact: true })).toBeVisible(); // el usuario es el correo
    await expect(section.getByText('Activa', { exact: true })).toBeVisible();
    await expect(section.getByText(/No activada/)).toBeVisible();
    expect(await serious(page)).toEqual([]);

    // clave débil
    await section.getByLabel('Clave nueva').fill('corta');
    await section.getByRole('button', { name: 'Asignar clave' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'al menos 12 caracteres' }),
    ).toBeVisible();

    // generar una clave la rellena, y se asigna sin exigir cambio
    await section.getByRole('button', { name: 'Generar clave' }).click();
    await section.getByRole('button', { name: 'Mostrar clave' }).click();
    const generated = await section.getByLabel('Clave nueva').inputValue();
    expect(generated).toHaveLength(16);
    await section.getByLabel(/Exigir que el empleado la cambie/).uncheck();
    await section.getByRole('button', { name: 'Asignar clave' }).click();
    await expect(
      page.getByText('Clave asignada. El empleado ya puede ingresar con ella'),
    ).toBeVisible();
    await expect(section.getByLabel('Clave nueva')).toHaveValue(''); // no se conserva en pantalla

    const emp = await session(browser, u, generated);
    await expect(emp.getByRole('heading', { name: `Hola, ${u.name}` })).toBeVisible();
    const anon = await (await browser.newContext()).newPage();
    await anon.goto('http://localhost:3100/login');
    await login(anon, u, u.password); // la anterior ya no sirve
    await expect(anon.locator('p[role="alert"]')).toBeVisible();
  });

  test('exigiendo el cambio, el empleado debe activar la cuenta con el código del correo', async ({
    page,
  }) => {
    await loginAdmin(page);
    const u = newUser('exige');
    await seedActiveAccount(u);
    const section = await openAccount(page, u);
    await section.getByLabel('Clave nueva').fill('Clave-Asignada-E2E-77');
    await section.getByRole('button', { name: 'Asignar clave' }).click();
    await expect(
      page.getByText('Clave asignada. El empleado debe activar su cuenta'),
    ).toBeVisible();
    await expect(section.getByText('Pendiente de activación')).toBeVisible();
    expect(
      await query(`select status::text, must_change_password from accounts where email = $1`, [
        u.email,
      ]),
    ).toEqual([{ status: 'PENDIENTE_VERIFICACION', must_change_password: true }]);
  });

  test('crea la cuenta de un empleado sin cuenta, con clave elegida, y muestra el doble paso y su desactivación', async ({
    page,
  }) => {
    await loginAdmin(page);
    const u = newUser('crea');
    await seedEmployee(u);
    const section = await openAccount(page, u);
    await expect(section.getByText('Sin cuenta')).toBeVisible();
    await section.getByLabel('Clave inicial (opcional)').fill('Clave-Elegida-E2E-55');
    await section.getByRole('button', { name: 'Crear cuenta' }).click();
    await expect(
      page.getByText('Cuenta creada. Se envió al correo del empleado el código'),
    ).toBeVisible();
    await expect(page.getByText('Clave temporal generada')).toHaveCount(0); // la elegida no se muestra
    await expect(section.getByText('Pendiente de activación')).toBeVisible();
    const rows = await query<{ password_hash: string }>(
      `select password_hash from accounts where email = $1`,
      [u.email],
    );
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.password_hash).not.toContain('Clave-Elegida-E2E-55');

    // con doble paso activado: el administrador lo ve y lo desactiva por recuperación
    await query(
      `update accounts set status = 'ACTIVA', two_factor_enabled = true, two_factor_enabled_at = now() where email = $1`,
      [u.email],
    );
    const again = await openAccount(page, u);
    await expect(again.getByText(/Activada desde/)).toBeVisible();
    await again.getByRole('button', { name: 'Desactivar doble paso' }).click();
    await expect(page.getByText('Verificación en dos pasos desactivada.')).toBeVisible();
    await expect(again.getByText(/No activada/)).toBeVisible();
    expect(
      await query(`select two_factor_enabled from accounts where email = $1`, [u.email]),
    ).toEqual([{ two_factor_enabled: false }]);
  });
});
