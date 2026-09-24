import { expect, test, type Page } from '@playwright/test';
import {
  newUser,
  pngBuffer,
  query,
  seedActiveAccount,
  seedAdminUser,
  seedCatalog,
  seedCompany,
  uid,
  xlsxBuffer,
  xlsxFile,
  type SeedUser,
} from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function asAdmin(
  page: Page,
  role: 'HR_ADMIN' | 'SYSTEM_ADMIN' = 'HR_ADMIN',
): Promise<SeedUser> {
  const admin = await seedAdminUser(role);
  await login(page, admin);
  return admin;
}

const info = (page: Page) => page.locator('p[role="status"], p[role="alert"]');

test.describe('acceso al área administrativa', () => {
  test('sin sesión lleva al ingreso', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('un empleado no ve el acceso y, si escribe la ruta, recibe acceso restringido', async ({
    page,
  }) => {
    const u = newUser('emp');
    await seedActiveAccount(u, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
    await login(page, u);
    await expect(page.getByRole('link', { name: 'Administración' })).toHaveCount(0);
    for (const path of ['/admin', '/admin/empleados', '/admin/auditoria', '/admin/cuentas']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Administración' })).toHaveCount(0);
    }
  });

  test('un empleado tampoco obtiene datos administrativos desde el navegador', async ({ page }) => {
    const u = newUser('emp');
    await seedActiveAccount(u);
    await login(page, u);
    for (const path of [
      '/api/admin/employees',
      '/api/admin/accounts',
      '/api/admin/audit',
      '/api/admin/summary',
      '/api/admin/payroll-concepts',
    ]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(403);
    }
  });

  for (const role of ['HR_ADMIN', 'SYSTEM_ADMIN'] as const) {
    test(`el administrador (${role}) ve el menú completo y el resumen`, async ({ page }) => {
      await asAdmin(page, role);
      await page.getByRole('link', { name: 'Administración' }).click();
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByRole('heading', { name: 'Resumen administrativo' })).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Administración' });
      for (const name of [
        'Resumen',
        'Empresas y logo',
        'Áreas, cargos y centros de costo',
        'Conceptos de nómina',
        'Empleados',
        'Cuentas y roles',
        'Importaciones',
        'Nómina publicada',
        'Auditoría',
      ]) {
        await expect(nav.getByRole('link', { name })).toBeVisible();
      }
      await expect(page.getByText('Cuentas activas')).toBeVisible();
    });
  }
});

test.describe('empresas y logo', () => {
  test('crea y edita una empresa', async ({ page }) => {
    await asAdmin(page);
    await page.goto('/admin/empresas');
    const cEmp = `E${uid().toUpperCase()}`;
    await page.getByRole('button', { name: 'Nueva empresa' }).click();
    await page.getByLabel('Código de la empresa').fill(cEmp);
    await page.getByLabel('Nombre legal').fill('Comercial de Prueba S.A.');
    await page.getByLabel('Sigla').fill('CPS');
    await page.getByLabel('Dirección').fill('Calle 10 # 20-30');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Empresa creada.')).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(cEmp) });
    await expect(row).toContainText('Comercial de Prueba S.A.');
    await expect(row).toContainText('Entero superior');

    await row.getByRole('button', { name: /Editar/ }).click();
    await page.getByLabel('Nombre legal').fill('Comercial Renovada S.A.');
    await page.getByLabel('Modo de presentación sugerido del volante').selectOption('SIN_AJUSTE');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Empresa actualizada.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(cEmp) })).toContainText('Sin ajuste');
  });

  test('rechaza un código de empresa repetido', async ({ page }) => {
    await asAdmin(page);
    const cEmp = `D${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await page.goto('/admin/empresas');
    await page.getByRole('button', { name: 'Nueva empresa' }).click();
    await page.getByLabel('Código de la empresa').fill(cEmp);
    await page.getByLabel('Nombre legal').fill('X');
    await page.getByLabel('Sigla').fill('X');
    await page.getByLabel('Dirección').fill('X');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ya existe una empresa con ese código.')).toBeVisible();
  });

  test('sube un logo, lo versiona, vuelve a una versión anterior y restablece el genérico', async ({
    page,
  }) => {
    await asAdmin(page);
    const cEmp = `L${uid().toUpperCase()}`;
    await seedCompany(cEmp, 'Empresa con logo');
    await page.goto('/admin/empresas');
    await page
      .getByRole('row', { name: new RegExp(cEmp) })
      .getByRole('button', { name: /Logo/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Todavía no se ha cargado ningún logo')).toBeVisible();

    await dialog.getByLabel('Archivo PNG o JPEG').setInputFiles({
      name: 'uno.png',
      mimeType: 'image/png',
      buffer: pngBuffer(100, 100, [10, 10, 200]),
    });
    await dialog.getByRole('button', { name: 'Cargar logo' }).click();
    await expect(dialog.getByText('Logo cargado.')).toBeVisible();
    await dialog.getByLabel('Archivo PNG o JPEG').setInputFiles({
      name: 'dos.png',
      mimeType: 'image/png',
      buffer: pngBuffer(120, 90, [10, 200, 10]),
    });
    await dialog.getByRole('button', { name: 'Cargar logo' }).click();
    await expect(dialog.getByRole('row', { name: /^2 / })).toContainText('En uso');
    await expect(dialog.getByRole('row', { name: /^1 / })).toContainText('Anterior');

    const img = dialog.getByRole('img', { name: /Logo actual/ });
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(120);

    await dialog.getByRole('button', { name: 'Usar esta versión' }).click();
    await expect(dialog.getByText('Versión activada.')).toBeVisible();
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(100);

    await dialog.getByRole('button', { name: 'Volver al logo genérico' }).click();
    await expect(dialog.getByText('Se restableció el logo genérico.')).toBeVisible();
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(400);
    const rows = await query<{ n: number }>(
      `select count(*)::int as n from company_logos l join companies c on c.id = l.company_id where c.c_emp = $1`,
      [cEmp],
    );
    expect(rows[0]?.n).toBe(2);
  });

  test('rechaza archivos que no son logos válidos con un mensaje claro', async ({ page }) => {
    await asAdmin(page);
    const cEmp = `R${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await page.goto('/admin/empresas');
    await page
      .getByRole('row', { name: new RegExp(cEmp) })
      .getByRole('button', { name: /Logo/ })
      .click();
    const dialog = page.getByRole('dialog');
    const send = async (file: { name: string; mimeType: string; buffer: Buffer }) => {
      await dialog.getByLabel('Archivo PNG o JPEG').setInputFiles(file);
      await dialog.getByRole('button', { name: 'Cargar logo' }).click();
    };
    await send({
      name: 'x.png',
      mimeType: 'image/png',
      buffer: Buffer.from('esto no es una imagen'),
    });
    await expect(dialog.getByText('no es una imagen PNG o JPEG válida')).toBeVisible();
    await send({ name: 'pequeno.png', mimeType: 'image/png', buffer: pngBuffer(32, 32) });
    await expect(dialog.getByText('entre 64 y 2000 píxeles')).toBeVisible();
    await send({
      name: 'grande.png',
      mimeType: 'image/png',
      buffer: Buffer.concat([pngBuffer(100, 100), Buffer.alloc(600 * 1024)]),
    });
    await expect(dialog.getByText('supera los 512 KB')).toBeVisible();
    await send({
      name: 'vector.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>'),
    });
    await expect(dialog.getByText('no es una imagen PNG o JPEG válida')).toBeVisible();
    const rows = await query<{ n: number }>(
      `select count(*)::int as n from company_logos l join companies c on c.id = l.company_id where c.c_emp = $1`,
      [cEmp],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

test.describe('catálogos: áreas, centros de costo, cargos y tipos de contrato', () => {
  test('crea, edita, consulta el historial y desactiva un área', async ({ page }) => {
    await asAdmin(page);
    const cEmp = `A${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await page.goto('/admin/catalogos');
    await page.getByLabel('Empresa', { exact: true }).selectOption(cEmp);

    await page.getByRole('button', { name: 'Nuevo área' }).click();
    await page.getByLabel('Código').fill('10300');
    await page.getByLabel('Nombre').fill('FINANCIERA');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Registro creado.')).toBeVisible();
    await expect(page.getByRole('row', { name: /10300/ })).toContainText('FINANCIERA');

    await page.getByRole('button', { name: 'Nuevo área' }).click();
    await page.getByLabel('Código').fill('10300');
    await page.getByLabel('Nombre').fill('OTRO');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ya existe un registro con ese código.')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();

    await page.getByRole('button', { name: 'Editar 10300' }).click();
    await page.getByLabel('Nombre').fill('FINANCIERA Y CONTABLE');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('row', { name: /10300/ })).toContainText('FINANCIERA Y CONTABLE');

    await page.getByRole('button', { name: 'Historial de 10300' }).click();
    await expect(page.getByRole('dialog')).toContainText(
      '«FINANCIERA» pasó a «FINANCIERA Y CONTABLE»',
    );
    await page.getByRole('button', { name: 'Cerrar' }).click();

    await page.getByRole('button', { name: 'Editar 10300' }).click();
    await page.getByLabel('Activo').uncheck();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('row', { name: /10300/ })).toContainText('Inactivo');
  });

  test('no permite desactivar un cargo en uso y explica por qué', async ({ page }) => {
    await asAdmin(page);
    const cEmp = `U${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await seedCatalog('CARGO', cEmp, 'C001', 'ANALISTA');
    await query(
      `insert into employee_snapshots (n_ide, n_cont, email, est, c_emp, c_car) values ($1, '1', $2, 'V', $3, 'C001')`,
      [`9${uid()}`, `uso-${uid()}@e2e.test`, cEmp],
    );
    await page.goto('/admin/catalogos');
    await page.getByLabel('Empresa', { exact: true }).selectOption(cEmp);
    await page.getByRole('tab', { name: 'Cargos' }).click();
    await page.getByRole('button', { name: 'Editar C001' }).click();
    await page.getByLabel('Activo').uncheck();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText('No se puede desactivar: está en uso por 1 empleado(s) vigente(s).'),
    ).toBeVisible();
  });

  test('los tipos de contrato son globales y conservan el cero inicial', async ({ page }) => {
    await asAdmin(page);
    await page.goto('/admin/catalogos');
    await page.getByRole('tab', { name: 'Tipos de contrato' }).click();
    await expect(page.getByLabel('Empresa', { exact: true })).toHaveCount(0);
    const code = `0${Math.floor(Math.random() * 9) + 1}${uid().slice(0, 3)}`;
    await page.getByRole('button', { name: 'Nuevo tipo de contrato' }).click();
    await page.getByLabel('Código').fill(code);
    await page.getByLabel('Nombre').fill('TÉRMINO INDEFINIDO');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Registro creado.')).toBeVisible();
    await page.getByLabel('Buscar').fill(code);
    await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText(
      'TÉRMINO INDEFINIDO',
    );
  });

  test('importa un catálogo desde Excel con vista previa y lo aplica', async ({ page }) => {
    await asAdmin(page);
    const cEmp = `I${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await page.goto('/admin/catalogos');
    await page.getByLabel('Empresa', { exact: true }).selectOption(cEmp);
    const section = page.getByRole('region', { name: /Importar áreas desde Excel/ });
    await section.getByLabel('Archivo Excel (.xlsx)').setInputFiles(
      xlsxFile(
        'AREAS.xlsx',
        await xlsxBuffer(
          ['C_ARE', 'NOMAREA', 'JEFE_AREA'],
          [
            ['10100', 'GERENCIA', null],
            ['10200', 'VENTAS', null],
          ],
        ),
      ),
    );
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Lista para aplicar')).toBeVisible();
    await expect(section.getByText('Registros nuevos')).toBeVisible();
    await section.getByRole('button', { name: 'Aplicar importación' }).click();
    await expect(section.getByText('Importación aplicada correctamente.')).toBeVisible();
    await expect(page.getByRole('row', { name: /10200/ })).toContainText('VENTAS');
  });

  test('un catálogo con códigos repetidos y nombres distintos se rechaza con el reporte de errores', async ({
    page,
  }) => {
    await asAdmin(page);
    const cEmp = `X${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await page.goto('/admin/catalogos');
    await page.getByLabel('Empresa', { exact: true }).selectOption(cEmp);
    await page.getByRole('tab', { name: 'Centros de costo' }).click();
    const section = page.getByRole('region', { name: /Importar centros de costo desde Excel/ });
    await section.getByLabel('Archivo Excel (.xlsx)').setInputFiles(
      xlsxFile(
        'CCOSTOS.xlsx',
        await xlsxBuffer(
          ['C_COS', 'CCOSTO'],
          [
            ['FA1403', 'PRODUCCION'],
            ['FA1403', 'PRODUCCI�N'],
          ],
        ),
      ),
    );
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText(/Con observaciones/)).toBeVisible();
    await expect(
      section.getByRole('row', { name: /código repetido con descripciones distintas/ }),
    ).toBeVisible();
    await expect(section.getByRole('button', { name: 'Aplicar importación' })).toHaveCount(0);
  });

  test('un archivo que no es Excel se rechaza con un mensaje claro', async ({ page }) => {
    await asAdmin(page);
    const cEmp = `N${uid().toUpperCase()}`;
    await seedCompany(cEmp);
    await page.goto('/admin/catalogos');
    await page.getByLabel('Empresa', { exact: true }).selectOption(cEmp);
    const section = page.getByRole('region', { name: /Importar áreas desde Excel/ });
    await section.getByLabel('Archivo Excel (.xlsx)').setInputFiles({
      name: 'falso.xlsx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('no soy un excel'),
    });
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('no es un Excel (.xlsx) válido')).toBeVisible();
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(info(page).first()).toBeVisible();
  });
});

test.describe('conceptos de nómina', () => {
  test('crea, filtra, edita la unidad y desactiva', async ({ page }) => {
    await asAdmin(page);
    await page.goto('/admin/conceptos');
    const code = `9${uid().slice(0, 4)}`;
    await page.getByRole('button', { name: 'Nuevo concepto' }).click();
    await page.getByLabel('Código del concepto').fill(code);
    await page.getByLabel('Descripción').fill('BONO DE PRUEBA');
    await page.getByLabel('Unidad de la cantidad').selectOption('HRS');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Concepto creado.')).toBeVisible();
    await page.getByLabel('Buscar').fill(code);
    const row = page.getByRole('row', { name: new RegExp(code) });
    await expect(row).toContainText('BONO DE PRUEBA');
    await expect(row).toContainText('HRS');

    await page.getByRole('button', { name: `Editar concepto ${code}` }).click();
    await page.getByLabel('Unidad de la cantidad').selectOption('PES');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('PES');

    await page.getByRole('button', { name: `Editar concepto ${code}` }).click();
    await page.getByLabel('Concepto activo').uncheck();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText('Inactivo');
    await page.getByLabel('Estado').selectOption('true');
    await expect(page.getByRole('row', { name: new RegExp(code) })).toHaveCount(0);
  });

  test('rechaza un código repetido', async ({ page }) => {
    await asAdmin(page);
    const code = `8${uid().slice(0, 4)}`;
    await query(`insert into payroll_concepts (code, name, unit) values ($1, 'YA EXISTE', 'PES')`, [
      code,
    ]);
    await page.goto('/admin/conceptos');
    await page.getByRole('button', { name: 'Nuevo concepto' }).click();
    await page.getByLabel('Código del concepto').fill(code);
    await page.getByLabel('Descripción').fill('OTRO');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ya existe un concepto con ese código.')).toBeVisible();
  });

  test('importa conceptos desde Excel conservando los ceros iniciales', async ({ page }) => {
    await asAdmin(page);
    await page.goto('/admin/conceptos');
    const a = `0${uid().slice(0, 3)}`;
    const b = `0${uid().slice(0, 3)}x`;
    const section = page.getByRole('region', { name: /Importar conceptos desde Excel/ });
    await section.getByLabel('Archivo Excel (.xlsx)').setInputFiles(
      xlsxFile(
        'conceptos.xlsx',
        await xlsxBuffer(
          ['CONCEPTO', 'NOMCONCEPTO', 'UNIDAD'],
          [
            [a, 'AJUSTE UNO', 'PES'],
            [b, 'HORAS EXTRA', 'HRS'],
          ],
        ),
      ),
    );
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Lista para aplicar')).toBeVisible();
    await section.getByRole('button', { name: 'Aplicar importación' }).click();
    await expect(section.getByText('Importación aplicada correctamente.')).toBeVisible();
    await page.getByLabel('Buscar').fill(a);
    await expect(page.getByRole('row', { name: new RegExp(a) })).toContainText('AJUSTE UNO');
    const rows = await query<{ code: string }>(
      `select code from payroll_concepts where code = $1`,
      [a],
    );
    expect(rows[0]?.code).toBe(a);
  });

  test('un archivo con códigos numéricos o unidades inválidas se rechaza', async ({ page }) => {
    await asAdmin(page);
    await page.goto('/admin/conceptos');
    const section = page.getByRole('region', { name: /Importar conceptos desde Excel/ });
    await section.getByLabel('Archivo Excel (.xlsx)').setInputFiles(
      xlsxFile(
        'malo.xlsx',
        await xlsxBuffer(
          ['CONCEPTO', 'NOMCONCEPTO', 'UNIDAD'],
          [
            [62, 'NUMÉRICO', 'PES'],
            ['A1', 'SIN UNIDAD', ''],
          ],
        ),
      ),
    );
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByRole('row', { name: /el código debe ser texto/ })).toBeVisible();
    await expect(section.getByRole('row', { name: /unidad vacía o inválida/ })).toBeVisible();
  });
});
