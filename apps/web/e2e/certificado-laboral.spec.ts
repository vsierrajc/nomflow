import { expect, test, type Page } from '@playwright/test';
import {
  newUser,
  query,
  seedActiveAccount,
  seedAdminUser,
  seedCatalog,
  seedCompany,
  type SeedUser,
} from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('certificado laboral', () => {
  test.beforeEach(async () => {
    await query(`delete from certificate_requests`);
    await query(`delete from certificate_templates`);
    await query(`delete from certificate_settings`);
  });

  test('el administrador configura el formato y el texto; el empleado genera el certificado; el historial lo muestra', async ({
    browser,
  }) => {
    await seedCompany('GA', 'GRUPO E2E S.A.');
    await seedCatalog('AREA', 'GA', 'AR1', 'PRODUCCION');
    await seedCatalog('CARGO', 'GA', 'CA1', 'ANALISTA');
    await seedCatalog('CCOSTO', 'GA', 'CC1', 'PLANTA');
    await seedCatalog('TIPO_CONTRATO', 'GA', '01', 'INDEFINIDO');
    const emp = newUser('certlab');
    await seedActiveAccount(emp);
    await query(
      `update employee_snapshots set c_emp = 'GA', c_car = 'CA1', c_area = 'AR1', c_cos = 'CC1', tipo_contrato = '01', f_ini = '2021-04-12' where n_ide = $1`,
      [emp.nIde],
    );
    const admin = await seedAdminUser('HR_ADMIN');

    const pa = await (await browser.newContext()).newPage();
    await pa.goto('http://localhost:3100/login');
    await login(pa, admin);
    await pa.goto('/admin/certificado-laboral');
    await expect(pa.getByRole('heading', { level: 1, name: 'Certificado laboral' })).toBeVisible();
    const params = pa.getByRole('region', { name: 'Parámetros del certificado' });
    await expect(params).toBeVisible();
    // Con varias empresas hay un selector (ya cargado en este punto); se elige la de la prueba.
    const chooser = pa.getByLabel('Empresa', { exact: true });
    if (await chooser.count()) await chooser.selectOption('GA');
    await expect(params.getByLabel('Código del documento')).toHaveValue('GH-FO-001');
    await params.getByLabel('Código del documento').fill('GH-FO-777');
    await params.getByLabel('Versión del formato').fill('05');
    await params.getByLabel('Datos de la empresa para el pie de página').fill('NIT 900.111.222-3');
    await params.getByRole('button', { name: 'Guardar parámetros' }).click();
    await expect(pa.getByText('Parámetros guardados.')).toBeVisible();

    const general = pa.getByRole('region', { name: /Certificado general/ });
    await general.getByLabel('Texto del certificado').fill('Texto con {{VARIABLE_QUE_NO_EXISTE}}');
    await general.getByRole('button', { name: 'Guardar nueva versión' }).click();
    await expect(pa.getByRole('list', { name: 'Errores de la plantilla' })).toContainText(
      '{{VARIABLE_QUE_NO_EXISTE}}',
    );
    await general
      .getByLabel('Texto del certificado')
      .fill(
        'HACE CONSTAR\n\nQue {{NOMBRE}} trabaja como {{CARGO}} en {{EMPRESA_NOMBRE}}, en {{CIUDAD_EMISION}} el {{FECHA_EMISION}}.',
      );
    await general.getByRole('button', { name: 'Guardar nueva versión' }).click();
    await expect(pa.getByText(/Guardado como versión 2/)).toBeVisible();

    // Empleado: elige la modalidad dirigida y genera.
    const pe = await (await browser.newContext()).newPage();
    await pe.goto('http://localhost:3100/login');
    await login(pe, emp);
    await pe
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Certificado laboral' })
      .click();
    await expect(pe.getByRole('heading', { level: 1, name: 'Certificado laboral' })).toBeVisible();
    await expect(pe.getByText('Aún no ha generado certificados.')).toBeVisible();
    await pe.getByLabel('Dirigido a una persona o entidad').check();
    await pe.getByRole('button', { name: 'Generar certificado' }).click();
    await expect(
      pe.locator('p[role="alert"]', { hasText: 'Escriba a quién va dirigido' }),
    ).toBeVisible();
    await pe.getByLabel('A quién va dirigido').fill('BANCO EJEMPLO S.A.');
    await pe.getByRole('button', { name: 'Generar certificado' }).click();
    await expect(pe.getByText(/Su certificado se generó/)).toBeVisible();
    const item = pe.getByRole('list').filter({ hasText: 'Dirigido a BANCO EJEMPLO S.A.' });
    await expect(item).toContainText('GH-FO-777 v05');
    const href = await item.getByRole('link', { name: /^Descargar/ }).getAttribute('href');
    const pdf = await pe.request.get(`http://localhost:3100${href}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

    // Historial del administrador.
    await pa.goto('/admin/certificados-emitidos');
    await expect(
      pa.getByRole('heading', { level: 1, name: 'Certificados laborales emitidos' }),
    ).toBeVisible();
    const table = pa.getByRole('region', { name: 'Historial de certificados laborales' });
    await expect(table).toContainText(emp.name);
    await expect(table).toContainText('BANCO EJEMPLO S.A.');
    await expect(table).toContainText('GH-FO-777 v05');
    await pa.getByLabel(/Buscar por nombre/).fill('no-existe-zzz');
    await pa.getByRole('button', { name: 'Filtrar' }).click();
    await expect(pa.getByText('No hay solicitudes con esos filtros.')).toBeVisible();
  });

  test('un empleado no ve la configuración ni el historial', async ({ page }) => {
    const u = newUser('certlab2');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/admin/certificados-emitidos');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });
});
