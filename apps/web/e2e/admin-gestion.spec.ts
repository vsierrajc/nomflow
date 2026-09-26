import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  latestCode,
  newUser,
  nextPeriod,
  query,
  seedActiveAccount,
  seedAdminUser,
  seedCatalog,
  seedCompany,
  seedEmployee,
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

async function setupOrg() {
  const cEmp = `G${uid().toUpperCase()}`;
  await seedCompany(cEmp);
  await seedCatalog('AREA', cEmp, '10300', 'FINANCIERA');
  await seedCatalog('AREA', cEmp, '10400', 'COMERCIAL');
  await seedCatalog('CCOSTO', cEmp, 'CC1', 'Costo Uno');
  await seedCatalog('CARGO', cEmp, 'CA1', 'Analista');
  await seedCatalog('TIPO_CONTRATO', cEmp, '01', 'Indefinido');
  return cEmp;
}

test.describe('empleados', () => {
  test('las listas dependen de la empresa: al cambiarla se recargan y se limpia la selección', async ({
    page,
  }) => {
    await asAdmin(page);
    const one = await setupOrg();
    const two = `G${uid().toUpperCase()}`;
    await seedCompany(two);
    await seedCatalog('AREA', two, '20100', 'LOGISTICA');
    await page.goto('/admin/empleados');
    await page.getByRole('button', { name: 'Nuevo empleado' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Empresa (C_EMP)').selectOption(one);
    await d.getByLabel('Área (C_AREA)').selectOption('10300');
    await d.getByLabel('Empresa (C_EMP)').selectOption(two);
    await expect(d.getByLabel('Área (C_AREA)').locator('option')).toHaveText([
      '- Seleccione un área -',
      '20100 - LOGISTICA',
    ]);
    await expect(d.getByLabel('Área (C_AREA)')).toHaveValue('');
  });

  test('alta excepcional, consulta, corrección con historial, baja y reactivación', async ({
    page,
  }) => {
    await asAdmin(page);
    const cEmp = await setupOrg();
    const u = newUser('nuevo');
    await page.goto('/admin/empleados');
    await page.getByRole('button', { name: 'Nuevo empleado' }).click();
    const d = page.getByRole('dialog');

    await d.getByLabel('Identificación (N_IDE)').fill(u.nIde);
    await d.getByLabel('Contrato (N_CONT)').fill('1');
    await d.getByLabel('Empresa (C_EMP)').selectOption(cEmp);
    await d.getByLabel('Nombre completo').fill(u.name);
    await d.getByLabel('Correo electrónico').fill(u.email);
    // Las listas vienen de los catálogos de la empresa elegida: no se escribe el código.
    const area = d.getByLabel('Área (C_AREA)');
    await expect(area.locator('option')).toHaveText([
      '- Seleccione un área -',
      '10300 - FINANCIERA',
      '10400 - COMERCIAL',
    ]);
    await expect(d.getByLabel('Centro de costo (C_COS)').locator('option')).toHaveText([
      '- Sin centro de costo -',
      'CC1 - Costo Uno',
    ]);
    await expect(d.getByLabel('Cargo (C_CAR)').locator('option')).toHaveText([
      '- Sin cargo -',
      'CA1 - Analista',
    ]);
    await d.getByLabel('Tipo de contrato').selectOption('01');
    await d.getByLabel('Fecha de inicio').fill('2020-01-06');
    await d.getByLabel('Salario actual').fill('1500000.5');
    await d.getByLabel(/Motivo del cambio/).fill('Alta excepcional solicitada por Gestión Humana');
    await d.getByRole('button', { name: 'Guardar' }).click();
    // sin elegir un área la petición se rechaza: en la lista no hay códigos inexistentes que escribir
    await expect(d.getByText(/Revise los datos/)).toBeVisible();

    await d.getByLabel('Área (C_AREA)').selectOption('10300');
    await d.getByLabel('Centro de costo (C_COS)').selectOption('CC1');
    await d.getByLabel('Cargo (C_CAR)').selectOption('CA1');
    await d.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Empleado creado.')).toBeVisible();

    await page.getByLabel('Buscar por nombre, identificación o correo').fill(u.nIde);
    const row = page.getByRole('row', { name: new RegExp(u.nIde) });
    await expect(row).toContainText('FINANCIERA');
    await expect(row).toContainText('Vigente');

    await row.getByRole('button', { name: /^Ver / }).click();
    await expect(page.getByRole('dialog')).toContainText('Salario actual');
    await expect(page.getByRole('dialog')).toContainText('1500000.500000');
    await expect(page.getByRole('dialog')).toContainText('Corrección manual');
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

    await row.getByRole('button', { name: /^Corregir / }).click();
    await page.getByRole('dialog').getByLabel('Área (C_AREA)').selectOption('10400');
    await page
      .getByRole('dialog')
      .getByLabel(/Motivo del cambio/)
      .fill('Traslado de área informado por la jefatura');
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Empleado actualizado.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(u.nIde) })).toContainText('COMERCIAL');
    await page
      .getByRole('row', { name: new RegExp(u.nIde) })
      .getByRole('button', { name: /^Ver / })
      .click();
    await expect(page.getByRole('dialog')).toContainText(
      'Traslado de área informado por la jefatura',
    );
    await expect(page.getByRole('dialog')).toContainText('Área: 10300 → 10400');
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();

    await page
      .getByRole('row', { name: new RegExp(u.nIde) })
      .getByRole('button', { name: /^Dar de baja / })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel(/Motivo/)
      .fill('corto');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar baja' }).click();
    await expect(
      page.getByRole('dialog').getByText('Escriba un motivo de al menos 10 caracteres.'),
    ).toBeVisible();
    await page
      .getByRole('dialog')
      .getByLabel(/Motivo/)
      .fill('Retiro voluntario del empleado');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar baja' }).click();
    await expect(page.getByText('Empleado dado de baja')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(u.nIde) })).toContainText('Cancelado');

    await page
      .getByRole('row', { name: new RegExp(u.nIde) })
      .getByRole('button', { name: /^Reactivar / })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel(/Motivo/)
      .fill('Reingreso del empleado a la empresa');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar reactivación' }).click();
    await expect(page.getByText('Empleado reactivado.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(u.nIde) })).toContainText('Vigente');
    const hist = await query<{ action: string }>(
      `select c.action from employee_changes c join employee_snapshots e on e.id = c.employee_id where e.n_ide = $1 order by c.at`,
      [u.nIde],
    );
    expect(hist.map((h) => h.action)).toEqual(['CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE']);
  });

  test('la baja cierra la sesión abierta del empleado', async ({ page, browser }) => {
    await asAdmin(page);
    const u = newUser('sesion');
    await seedActiveAccount(u);
    const emp = await otherSession(browser, u);
    expect((await emp.request.get('/api/auth/me')).status()).toBe(200);

    await page.goto('/admin/empleados');
    await page.getByLabel('Buscar por nombre, identificación o correo').fill(u.nIde);
    await page
      .getByRole('row', { name: new RegExp(u.nIde) })
      .getByRole('button', { name: /^Dar de baja / })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel(/Motivo/)
      .fill('Terminación del contrato laboral');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar baja' }).click();
    await expect(page.getByText('se cerraron sus sesiones')).toBeVisible();
    expect((await emp.request.get('/api/auth/me')).status()).toBe(401);
    await emp.context().close();
  });
});

test.describe('cuentas y roles', () => {
  test('crea una cuenta, muestra la clave temporal una sola vez y envía el código por correo', async ({
    page,
  }) => {
    await asAdmin(page);
    const u = newUser('cuenta');
    await seedEmployee(u);
    await page.goto('/admin/cuentas');
    await page.getByRole('button', { name: 'Crear cuenta' }).click();
    await page.getByLabel('Identificación del empleado (N_IDE)').fill('0000000');
    await page.getByRole('button', { name: 'Crear cuenta' }).last().click();
    await expect(page.getByText('No hay ningún empleado con esa identificación.')).toBeVisible();
    await page.getByLabel('Identificación del empleado (N_IDE)').fill(u.nIde);
    await page.getByRole('button', { name: 'Crear cuenta' }).last().click();

    const secret = page.getByTestId('temporary-password');
    await expect(secret).toBeVisible();
    await expect(secret).toHaveText(/^[A-Za-z0-9_-]{16,}$/);
    await expect(
      page.getByText('Se envió un código de verificación al correo registrado.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Ya la entregué' }).click();
    await expect(page.getByTestId('temporary-password')).toHaveCount(0);
    expect(await latestCode(u.email)).toMatch(/^[A-Z0-9]{8}$/);

    await page.getByLabel('Buscar por correo o identificación').fill(u.email);
    await expect(page.getByRole('row', { name: new RegExp(u.email) })).toContainText(
      'Pendiente de activar',
    );

    await page.getByRole('button', { name: 'Crear cuenta' }).first().click();
    await page.getByLabel('Identificación del empleado (N_IDE)').fill(u.nIde);
    await page.getByRole('button', { name: 'Crear cuenta' }).last().click();
    await expect(page.getByText('Esa persona ya tiene una cuenta.')).toBeVisible();
  });

  test('bloquea y desbloquea; la persona bloqueada no puede ingresar', async ({
    page,
    browser,
  }) => {
    await asAdmin(page);
    const u = newUser('bloq');
    await seedActiveAccount(u);
    const emp = await otherSession(browser, u);
    await page.goto('/admin/cuentas');
    await page.getByLabel('Buscar por correo o identificación').fill(u.email);
    await page.getByRole('button', { name: `Bloquear ${u.email}` }).click();
    await expect(page.getByText('Cuenta bloqueada y sesiones cerradas.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(u.email) })).toContainText('Bloqueada');
    expect((await emp.request.get('/api/auth/me')).status()).toBe(401);
    const denied = await emp.request.post('/api/auth/login', {
      data: { email: u.email, password: u.password },
    });
    expect(denied.status()).toBe(401);

    await page.getByRole('button', { name: `Desbloquear ${u.email}` }).click();
    await expect(page.getByText('Cuenta desbloqueada.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(u.email) })).toContainText('Activa');
    const ok = await emp.request.post('/api/auth/login', {
      data: { email: u.email, password: u.password },
    });
    expect(ok.status()).toBe(200);
    await emp.context().close();
  });

  test('restablece la clave: nueva clave temporal y cuenta pendiente de activar', async ({
    page,
  }) => {
    await asAdmin(page);
    const u = newUser('reset');
    await seedActiveAccount(u);
    await page.goto('/admin/cuentas');
    await page.getByLabel('Buscar por correo o identificación').fill(u.email);
    await page.getByRole('button', { name: `Restablecer clave de ${u.email}` }).click();
    await expect(page.getByTestId('temporary-password')).toHaveText(/^[A-Za-z0-9_-]{16,}$/);
    await page.getByRole('button', { name: 'Ya la entregué' }).click();
    await expect(page.getByRole('row', { name: new RegExp(u.email) })).toContainText(
      'Pendiente de activar',
    );
  });

  test('no permite actuar sobre la propia cuenta', async ({ page }) => {
    const admin = await asAdmin(page);
    await page.goto('/admin/cuentas');
    await page.getByLabel('Buscar por correo o identificación').fill(admin.email);
    const row = page.getByRole('row', { name: new RegExp(admin.email) });
    await expect(row).toContainText('Administrador de Gestión Humana');
    await expect(row.getByRole('button', { name: /Bloquear|Restablecer/ })).toHaveCount(0);
    await row.getByRole('button', { name: /Roles de/ }).click();
    await expect(page.getByRole('dialog')).toContainText('no puede modificar sus roles');
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Conceder rol' }),
    ).toHaveCount(0);
  });

  test('concede el rol de jefe de área, lo asigna a un área y lo termina', async ({ page }) => {
    await asAdmin(page);
    const cEmp = await setupOrg();
    const u = newUser('jefe');
    await seedActiveAccount(u);
    await page.goto('/admin/cuentas');
    await page.getByLabel('Buscar por correo o identificación').fill(u.email);
    await page.getByRole('button', { name: `Roles de ${u.email}` }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByLabel('Rol', { exact: true })).not.toContainText(
      'Administrador del sistema',
    );

    // Empresa y área son listas tomadas de las tablas: no se escribe el código.
    await d.getByLabel('Empresa', { exact: true }).selectOption(cEmp);
    await expect(d.getByLabel('Área', { exact: true }).locator('option')).toHaveText([
      '- Seleccione un área -',
      '10300 - FINANCIERA',
      '10400 - COMERCIAL',
    ]);
    // sin elegir un área no se concede
    await d.getByRole('button', { name: 'Conceder rol' }).click();
    await expect(
      d.locator('p[role="alert"]', { hasText: 'Elija el área de la lista.' }),
    ).toBeVisible();
    await d.getByLabel('Área', { exact: true }).selectOption('10300');
    await d.getByRole('button', { name: 'Conceder rol' }).click();
    await expect(d.getByText('Rol concedido.')).toBeVisible();
    await expect(d.getByRole('row', { name: /Jefe de área/ })).toContainText(
      `Área 10300 (${cEmp})`,
    );

    await d.getByRole('button', { name: 'Asignar como jefe del área' }).click();
    await expect(d.getByText('Asignada como jefe del área 10300.')).toBeVisible();
    await expect(d.getByText('Jefe vigente')).toBeVisible();
    const assigned = await query<{ n: number }>(
      `select count(*)::int as n from area_manager_assignments where c_emp = $1 and c_area = '10300'`,
      [cEmp],
    );
    expect(assigned[0]?.n).toBe(1);

    await d.getByRole('button', { name: 'Terminar jefatura' }).click();
    await expect(d.getByText('Jefatura terminada a partir de hoy.')).toBeVisible();
    await d.getByRole('button', { name: /Terminar rol/ }).click();
    await expect(d.getByText('Rol terminado a partir de hoy.')).toBeVisible();
  });

  test('solo un administrador del sistema ve los roles administrativos', async ({ page }) => {
    await asAdmin(page, 'SYSTEM_ADMIN');
    const u = newUser('rol');
    await seedActiveAccount(u);
    await page.goto('/admin/cuentas');
    await page.getByLabel('Buscar por correo o identificación').fill(u.email);
    await page.getByRole('button', { name: `Roles de ${u.email}` }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Rol', { exact: true }).selectOption('HR_ADMIN');
    await d.getByRole('button', { name: 'Conceder rol' }).click();
    await expect(d.getByText('Rol concedido.')).toBeVisible();
    await expect(d.getByRole('row', { name: /Administrador de Gestión Humana/ })).toBeVisible();
  });
});

test.describe('importaciones y volantes', () => {
  test('importa empleados desde Excel y los cataloga', async ({ page }) => {
    await asAdmin(page);
    const cEmp = await setupOrg();
    const u = newUser('imp');
    await page.goto('/admin/importaciones');
    const section = page.getByRole('region', { name: /Importar empleados desde Excel/ });
    const cols = [
      'C_EMP',
      'N_IDE',
      'NOMBRE',
      'C_COS',
      'CCOSTO',
      'S_ACT',
      'N_CONT',
      'C_CAR',
      'C_AREA',
      'FEC_NAC',
      'CARGO',
      'AREA',
      'HLIQ',
      'SEXO',
      'F_INI',
      'TURNO',
      'EST',
      'EMAIL',
      'NOMBRES',
      'APELLIDOS',
      'CELULAR',
      'PROFESION',
      'NIVELEDUCATIVO',
      'TIPO_CONTRATO',
    ];
    const row = (est: string) => [
      cEmp,
      u.nIde,
      u.name,
      'CC1',
      'Costo Uno',
      1500000,
      '1',
      'CA1',
      '10300',
      new Date(Date.UTC(1990, 0, 2)),
      'Analista',
      'FINANCIERA',
      15,
      'F',
      new Date(Date.UTC(2020, 0, 6)),
      'D',
      est,
      u.email,
      'A',
      'B',
      null,
      null,
      null,
      '01',
    ];

    await section
      .getByLabel('Archivo Excel (.xlsx)')
      .setInputFiles(xlsxFile('EMPLEADOS.xlsx', await xlsxBuffer(cols, [row('A')])));
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(
      section.getByRole('row', { name: /EST debe ser V \(vigente\) o C \(cancelado\)/ }),
    ).toBeVisible();
    await expect(section.getByRole('button', { name: 'Aplicar importación' })).toHaveCount(0);

    await section
      .getByLabel('Archivo Excel (.xlsx)')
      .setInputFiles(xlsxFile('EMPLEADOS2.xlsx', await xlsxBuffer(cols, [row('V')])));
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Lista para aplicar')).toBeVisible();
    await section.getByRole('button', { name: 'Aplicar importación' }).click();
    await expect(section.getByText('Importación aplicada correctamente.')).toBeVisible();
    const rows = await query<{ est: string; source: string }>(
      `select est::text, source from employee_snapshots where n_ide = $1`,
      [u.nIde],
    );
    expect(rows).toEqual([{ est: 'V', source: 'IMPORT' }]);
    await expect(page.getByRole('row', { name: /Empleados.*APLICADO/ }).first()).toBeVisible();
  });

  test('importa una liquidación, la publica, y tanto el empleado como el administrador descargan el volante', async ({
    page,
    browser,
  }) => {
    const admin = await asAdmin(page);
    const cEmp = await setupOrg();
    const u = newUser('pago');
    await seedActiveAccount(u);
    await query(`update employee_snapshots set c_emp = $1 where n_ide = $2`, [cEmp, u.nIde]);
    const per = await nextPeriod();
    const cols = [
      'PER',
      'N_LIQ',
      'N_IDE',
      'CONTRATO',
      'NOMBRE',
      'C_CON',
      'CONCEPTO',
      'SLRIO',
      'CANT',
      'DED',
      'DEV',
      'TERCERO',
    ];

    await page.goto('/admin/importaciones');
    await page.getByRole('tab', { name: 'Nómina' }).click();
    const section = page.getByRole('region', {
      name: /Importar una liquidación de nómina desde Excel/,
    });
    await section.getByLabel('Período (AAAAMM)').fill(per);
    await section.getByLabel('Liquidación (1 o 2)').fill('1');
    const rows = [
      [
        per,
        1,
        u.nIde,
        '1',
        u.name,
        '100',
        'Salario básico',
        '1500000.5',
        15,
        null,
        '750000.25',
        null,
      ],
      [
        per,
        1,
        u.nIde,
        '1',
        u.name,
        '200',
        'Aporte salud',
        '1500000.5',
        null,
        '30000.01',
        null,
        null,
      ],
    ];
    const original = await xlsxBuffer(cols, rows);
    await section
      .getByLabel('Archivo Excel (.xlsx)')
      .setInputFiles(xlsxFile('NOMINA.xlsx', original));
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Lista para aplicar')).toBeVisible();
    await expect(section.getByText('Conceptos sin catálogo')).toBeVisible();
    await section.getByRole('button', { name: 'Aplicar importación' }).click();
    await expect(section.getByText('Importación aplicada correctamente.')).toBeVisible();

    await section
      .getByLabel('Archivo Excel (.xlsx)')
      .setInputFiles(xlsxFile('NOMINA.xlsx', original));
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Ese mismo archivo ya fue aplicado antes')).toBeVisible();

    const reordered = await xlsxBuffer(cols, [...rows].reverse());
    await section
      .getByLabel('Archivo Excel (.xlsx)')
      .setInputFiles(xlsxFile('NOMINA-reexportada.xlsx', reordered));
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Ese contenido ya está publicado')).toBeVisible();

    await page.goto('/admin/nomina');
    await expect(
      page.getByRole('row', { name: new RegExp(`${per.slice(0, 4)}.*Publicada`) }),
    ).toBeVisible();

    const emp = await otherSession(browser, u);
    await emp.goto('/volantes');
    const [own] = await Promise.all([
      emp.waitForEvent('download'),
      emp.getByRole('link', { name: /Descargar PDF/ }).click(),
    ]);
    expect(
      readFileSync(await own.path())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    await emp.context().close();

    await page.getByLabel('Identificación del empleado').fill(u.nIde);
    await page.getByRole('button', { name: 'Buscar volantes' }).click();
    await page.getByRole('button', { name: /^Descargar volante de/ }).click();
    await expect(page.getByText('Escriba el motivo del acceso')).toBeVisible();
    await page.getByLabel(/Motivo del acceso/).fill('Revisión solicitada por auditoría interna');
    const [adminDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^Descargar volante de/ }).click(),
    ]);
    expect(
      readFileSync(await adminDownload.path())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    await expect(page.getByText('El acceso quedó registrado con su motivo.')).toBeVisible();

    const audit = await query<{ reason: string; target_n_ide: string }>(
      `select reason, target_n_ide from payroll_download_audit where target_n_ide = $1`,
      [u.nIde],
    );
    expect(audit).toEqual([
      { reason: 'Revisión solicitada por auditoría interna', target_n_ide: u.nIde },
    ]);
    await page.goto('/admin/auditoria');
    await page.getByLabel('Actividad').fill('ADMIN_PAYROLL_ACCESS');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(
      page.getByRole('row', { name: new RegExp(`ADMIN_PAYROLL_ACCESS`) }).first(),
    ).toContainText(admin.email);
  });
});

test.describe('auditoría de peticiones y actividades', () => {
  test('el administrador ve las peticiones y actividades de todos los usuarios, con filtros', async ({
    page,
    browser,
  }) => {
    await asAdmin(page);
    const u = newUser('audit');
    await seedActiveAccount(u);
    const emp = await otherSession(browser, u);
    await emp.goto('/volantes');
    await emp.request.get('/api/admin/employees');
    await emp.context().close();

    await page.goto('/admin/auditoria');
    await page.getByLabel('Usuario (correo)').fill(u.email);
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page.getByRole('row', { name: /GET \/auth\/me/ }).first()).toContainText(u.email);
    await expect(page.getByRole('row', { name: /GET \/me\/payroll/ }).first()).toBeVisible();
    const forbidden = page.getByRole('row', { name: /GET \/admin\/employees/ }).first();
    await expect(forbidden).toContainText('403');

    await page.getByLabel('Tipo').selectOption('EVENT');
    await page.getByLabel('Usuario (correo)').fill(u.email);
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page.getByRole('row', { name: /LOGIN/ }).first()).toContainText('Actividad');

    await page.getByLabel('Tipo').selectOption('HTTP');
    await page.getByLabel('Usuario (correo)').fill('');
    await page.getByLabel('Estado').fill('401');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page.getByRole('row', { name: /\(sin sesión\)/ }).first()).toBeVisible();
    await expect(page.getByText(/página 1 de/)).toBeVisible();
  });

  test('la consulta no muestra claves, códigos ni cuerpos de las peticiones', async ({
    page,
    browser,
  }) => {
    await asAdmin(page);
    const u = newUser('priv');
    await seedActiveAccount(u);
    const emp = await otherSession(browser, u);
    await emp.request.post('/api/auth/login', {
      data: { email: u.email, password: 'ClaveSecretaDePrueba-77' },
    });
    await emp.context().close();
    await page.goto('/admin/auditoria');
    await expect(page.getByRole('table', { name: /Registro de auditoría/ })).toBeVisible();
    const html = await page.content();
    for (const secret of [u.password, 'ClaveSecretaDePrueba-77'])
      expect(html).not.toContain(secret);
  });
});

test.describe('confirmación de identidad para acciones sensibles', () => {
  test('con la sesión antigua pide la clave, rechaza una incorrecta y completa la acción con la correcta', async ({
    page,
  }) => {
    const admin = await asAdmin(page);
    await query(
      `update sessions set created_at = now() - interval '11 minutes' where account_id = (select id from accounts where email = $1)`,
      [admin.email],
    );
    await page.goto('/admin/empresas');
    const cEmp = `S${uid().toUpperCase()}`;
    await page.getByRole('button', { name: 'Nueva empresa' }).click();
    await page.getByLabel('Código de la empresa').fill(cEmp);
    await page.getByLabel('Nombre legal').fill('Empresa reautenticada');
    await page.getByLabel('Sigla').fill('ER');
    await page.getByLabel('Dirección').fill('Calle 5');
    await page.getByRole('button', { name: 'Guardar' }).click();

    const dialog = page.getByRole('dialog', { name: 'Confirme su identidad' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Clave').fill('clave-incorrecta');
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(dialog.getByText('La clave es incorrecta.')).toBeVisible();
    await dialog.getByLabel('Clave').fill(admin.password);
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Empresa creada.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(cEmp) })).toBeVisible();
  });

  test('si se cancela la confirmación, la acción no se realiza', async ({ page }) => {
    const admin = await asAdmin(page);
    await query(
      `update sessions set created_at = now() - interval '11 minutes' where account_id = (select id from accounts where email = $1)`,
      [admin.email],
    );
    await page.goto('/admin/empresas');
    const cEmp = `C${uid().toUpperCase()}`;
    await page.getByRole('button', { name: 'Nueva empresa' }).click();
    await page.getByLabel('Código de la empresa').fill(cEmp);
    await page.getByLabel('Nombre legal').fill('Cancelada');
    await page.getByLabel('Sigla').fill('C');
    await page.getByLabel('Dirección').fill('C');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await page
      .getByRole('dialog', { name: 'Confirme su identidad' })
      .getByRole('button', { name: 'Cancelar' })
      .click();
    await expect(page.getByText('Se canceló la confirmación de identidad.')).toBeVisible();
    const rows = await query<{ n: number }>(
      `select count(*)::int as n from companies where c_emp = $1`,
      [cEmp],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

test.describe('accesibilidad del área administrativa', () => {
  test('sin violaciones graves en todas las pantallas', async ({ page }) => {
    await asAdmin(page);
    const cEmp = await setupOrg();
    await query(
      `insert into payroll_concepts (code, name, unit) values ($1, 'CONCEPTO A11Y', 'PES') on conflict do nothing`,
      [`A${uid().slice(0, 4)}`],
    );
    for (const path of [
      '/admin',
      '/admin/empresas',
      '/admin/catalogos',
      '/admin/conceptos',
      '/admin/empleados',
      '/admin/cuentas',
      '/admin/importaciones',
      '/admin/nomina',
      '/admin/vacaciones',
      '/admin/festivos',
      '/admin/tipos-permiso',
      '/admin/correo',
      '/admin/retenciones',
      '/admin/auditoria',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map((v) => `${v.id}: ${v.help} (${v.nodes[0]?.target.join(' ')})`),
        path,
      ).toEqual([]);
    }
    void cEmp;
  });

  test('sin violaciones graves con un diálogo abierto y se cierra con Escape', async ({ page }) => {
    await asAdmin(page);
    await page.goto('/admin/empleados');
    await page.getByRole('button', { name: 'Nuevo empleado' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.help}`),
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('las pantallas administrativas funcionan en un teléfono sin desplazamiento horizontal de la página', async ({
    page,
  }) => {
    await asAdmin(page);
    await page.setViewportSize({ width: 390, height: 800 });
    for (const path of ['/admin', '/admin/empleados', '/admin/cuentas', '/admin/auditoria']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflow, path).toBe(false);
    }
  });
});
