import { expect, test, type Page } from '@playwright/test';
import { newUser, pngBuffer, query, seedActiveAccount, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('firma de aprobación de vacaciones', () => {
  test('solo quien aprueba ve la pestaña; carga con autorización, la ve y la retira', async ({
    browser,
  }) => {
    const mgr = newUser('firmajefe');
    await seedActiveAccount(mgr, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
    const emp = newUser('firmaemp');
    await seedActiveAccount(emp);

    // un empleado sin rol de aprobación no tiene la pestaña ni puede usar la pantalla
    const pe = await (await browser.newContext()).newPage();
    await pe.goto('http://localhost:3100/login');
    await login(pe, emp);
    await pe.goto('/cuenta/clave');
    await expect(
      pe
        .getByRole('navigation', { name: 'Mi cuenta' })
        .getByRole('link', { name: 'Mi firma de aprobación' }),
    ).toHaveCount(0);
    await pe.goto('/cuenta/firma');
    await expect(pe.getByText('No tiene un rol que apruebe vacaciones.')).toBeVisible();
    await pe.context().close();

    // el jefe de área sí
    const pm = await (await browser.newContext()).newPage();
    await pm.goto('http://localhost:3100/login');
    await login(pm, mgr);
    await pm.goto('/cuenta/clave');
    await pm
      .getByRole('navigation', { name: 'Mi cuenta' })
      .getByRole('link', { name: 'Mi firma de aprobación' })
      .click();
    await expect(
      pm.getByRole('heading', { level: 1, name: 'Mi firma de aprobación' }),
    ).toBeVisible();
    await expect(pm.getByText('Falta su firma')).toBeVisible();

    const file = {
      name: 'firma.png',
      mimeType: 'image/png',
      buffer: pngBuffer(240, 100, [20, 20, 20]),
    };
    // sin elegir imagen y sin autorización no se envía
    await pm.getByRole('button', { name: 'Cargar mi firma' }).click();
    await expect(pm.getByText('Elija la imagen de su firma.')).toBeVisible();
    await pm.getByLabel(/Imagen de su firma/).setInputFiles(file);
    await pm.getByRole('button', { name: 'Cargar mi firma' }).click();
    await expect(pm.getByText('Debe marcar la autorización para cargar su firma.')).toBeVisible();

    await pm.getByLabel(/Autorizo que NOMFLOW inserte/).check();
    await pm.getByRole('button', { name: 'Cargar mi firma' }).click();
    await expect(pm.getByText('Su firma quedó cargada y autorizada.')).toBeVisible();
    await expect(pm.getByRole('img', { name: 'Su firma cargada' })).toBeVisible();
    expect(
      await query(
        `select 1 from approver_signatures s join accounts a on a.id = s.account_id where a.n_ide = $1`,
        [mgr.nIde],
      ),
    ).toHaveLength(1);

    await pm.getByRole('button', { name: 'Retirar mi firma' }).click();
    await expect(pm.getByText(/Retiró su firma/)).toBeVisible();
    await expect(pm.getByText('Falta su firma')).toBeVisible();
    expect(
      await query(
        `select 1 from approver_signatures s join accounts a on a.id = s.account_id where a.n_ide = $1`,
        [mgr.nIde],
      ),
    ).toHaveLength(0);
    await pm.context().close();
  });
});
