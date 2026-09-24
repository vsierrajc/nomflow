import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, uid, type SeedUser } from './support';

async function session(browser: Browser, u: SeedUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

const PDF = {
  name: 'soporte.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n% soporte e2e\n%%EOF\n'),
};

async function scenario() {
  const area = `P${uid().toUpperCase()}`;
  const emp = newUser('psol');
  const mgr = newUser('pjef');
  await seedActiveAccount(emp);
  await seedActiveAccount(mgr, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: area }]);
  for (const u of [emp, mgr])
    await query(`update employee_snapshots set c_area = $1 where n_ide = $2`, [area, u.nIde]);
  const [m] = await query<{ id: string }>(`select id from accounts where n_ide = $1`, [mgr.nIde]);
  await query(
    `insert into area_manager_assignments (c_emp, c_area, manager_account_id, valid_from, created_by) values ('GA', $1, $2, '2020-01-01', $2)`,
    [area, m?.id],
  );
  const code = `T${uid().toUpperCase()}`;
  await query(
    `insert into permit_types (code, name, support_required, allows_hours, max_days) values ($1, $2, true, true, 3)`,
    [code, `Cita médica ${code}`],
  );
  return { emp, mgr, typeName: `Cita médica ${code}` };
}

test.describe('permisos: empleado y jefe de área', () => {
  test('el empleado solicita con soporte y el jefe de área lo aprueba, sin más aprobaciones', async ({
    browser,
  }) => {
    const { emp, mgr, typeName } = await scenario();
    const e = await session(browser, emp);
    await e.goto('/permisos');
    await expect(e.getByRole('heading', { level: 1, name: 'Mis permisos' })).toBeVisible();
    await e.getByLabel('Tipo de permiso').selectOption({ label: typeName });
    await e.getByLabel('Fecha inicial').fill('2036-04-07');
    await e.getByLabel('Justificación (mínimo 10 caracteres)').fill('corta');
    await e.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(e.locator('p[role="alert"]', { hasText: 'Justificación' })).toBeVisible();
    await e
      .getByLabel('Justificación (mínimo 10 caracteres)')
      .fill('Cita médica programada con especialista');
    await e.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(
      e.locator('p[role="alert"]', { hasText: 'exige adjuntar un soporte' }),
    ).toBeVisible();

    // permiso por horas del mismo día, con soporte
    await e.getByLabel('Hora inicial (opcional)').fill('08:00');
    await e.getByLabel('Hora final (opcional)').fill('10:00');
    await e.getByLabel(/Soporte \(PDF, PNG o JPEG/).setInputFiles(PDF);
    await e.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(e.getByText('Permiso enviado.')).toBeVisible();
    await expect(e.getByText('Pendiente del jefe de área').first()).toBeVisible();
    expect(
      await query(`select status, start_time, end_time from permit_requests where n_ide = $1`, [
        emp.nIde,
      ]),
    ).toEqual([{ status: 'PENDIENTE_JEFE', start_time: '08:00', end_time: '10:00' }]);

    // el jefe ve el permiso de su subordinado y lo aprueba
    const m = await session(browser, mgr);
    await m.goto('/aprobaciones');
    await m.getByRole('tab', { name: 'Permisos' }).click();
    await m.getByRole('button', { name: /Revisar el permiso de/ }).click();
    await expect(m.getByRole('link', { name: /Descargar soporte.pdf/ })).toBeVisible();
    await m.getByRole('button', { name: 'Aprobar' }).click();
    await expect(m.getByText('Permiso aprobado. No requiere más aprobaciones.')).toBeVisible();
    expect(await query(`select status from permit_requests where n_ide = $1`, [emp.nIde])).toEqual([
      { status: 'APROBADO' },
    ]);

    await e.goto('/permisos');
    await expect(e.getByText('Aprobado').first()).toBeVisible();
    await e.getByRole('button', { name: /Ver detalle del permiso/ }).click();
    await expect(e.getByText('Aprobado por el jefe de área').first()).toBeVisible();

    for (const [page, path] of [
      [e, '/permisos'],
      [m, '/aprobaciones'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const serious = (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
      ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        serious.map((v) => `${v.id}: ${v.help}`),
        path,
      ).toEqual([]);
    }
  });

  test('el jefe rechaza con motivo y el empleado puede cancelar otro permiso', async ({
    browser,
  }) => {
    const { emp, mgr, typeName } = await scenario();
    const e = await session(browser, emp);
    const send = async (day: string) => {
      await e.goto('/permisos');
      await e.getByLabel('Tipo de permiso').selectOption({ label: typeName });
      await e.getByLabel('Fecha inicial').fill(day);
      await e
        .getByLabel('Justificación (mínimo 10 caracteres)')
        .fill('Trámite personal ineludible');
      await e.getByLabel(/Soporte \(PDF, PNG o JPEG/).setInputFiles(PDF);
      await e.getByRole('button', { name: 'Enviar solicitud' }).click();
      await expect(e.getByText('Permiso enviado.')).toBeVisible();
    };
    await send('2036-05-05');
    await send('2036-06-02');

    const m = await session(browser, mgr);
    await m.goto('/aprobaciones');
    await m.getByRole('tab', { name: 'Permisos' }).click();
    await m.getByRole('button', { name: /Revisar el permiso de .*5 de mayo de 2036/ }).click();
    await m.getByRole('button', { name: 'Rechazar' }).click();
    const form = m.getByRole('form', { name: 'Rechazar permiso' });
    await form.getByLabel(/Motivo del rechazo/).fill('corto');
    await form.getByRole('button', { name: 'Confirmar rechazo' }).click();
    await expect(m.locator('p[role="alert"]', { hasText: 'Escriba el motivo' })).toBeVisible();
    await form.getByLabel(/Motivo del rechazo/).fill('Coincide con el cierre del trimestre');
    await form.getByRole('button', { name: 'Confirmar rechazo' }).click();
    await expect(m.getByText('Permiso rechazado con su motivo.')).toBeVisible();

    await e.goto('/permisos');
    await e
      .getByRole('listitem')
      .filter({ hasText: '2 de junio de 2036' })
      .getByRole('button', { name: 'Cancelar solicitud' })
      .click();
    await expect(e.getByText('Permiso cancelado.')).toBeVisible();
    expect(
      (
        await query<{ status: string }>(
          `select status from permit_requests where n_ide = $1 order by start_date`,
          [emp.nIde],
        )
      ).map((r) => r.status),
    ).toEqual(['RECHAZADO', 'CANCELADO']);
  });

  test('el administrador configura los tipos de permiso; un empleado sin rol no ve la bandeja', async ({
    browser,
  }) => {
    const admin = await session(browser, await seedAdminUser('HR_ADMIN'));
    await admin.goto('/admin/tipos-permiso');
    await expect(admin.getByRole('heading', { level: 1, name: 'Tipos de permiso' })).toBeVisible();
    const code = `X${uid().toUpperCase()}`;
    const form = admin.getByRole('region', { name: 'Nuevo tipo' });
    await form.getByLabel(/Código/).fill('con espacio');
    await form.getByLabel('Nombre').fill(`Tipo ${code}`);
    await form.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(admin.locator('p[role="alert"]', { hasText: 'Revise el código' })).toBeVisible();
    await form.getByLabel(/Código/).fill(code);
    await form.getByLabel('Máximo de días por solicitud').fill('2');
    await form.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(admin.getByText('Tipo creado.')).toBeVisible();
    await expect(
      admin.getByRole('row', { name: new RegExp(`${code}.*Tipo ${code}.*Activo`) }),
    ).toBeVisible();
    await admin.getByRole('button', { name: `Editar el tipo Tipo ${code}` }).click();
    const edit = admin.getByRole('region', { name: 'Editar tipo' });
    await edit.getByLabel('Activo (se ofrece a los empleados)').uncheck();
    await edit.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(admin.getByText('Tipo actualizado.')).toBeVisible();
    await expect(admin.getByRole('row', { name: new RegExp(`${code}.*Inactivo`) })).toBeVisible();

    const u = newUser('psinrol');
    await seedActiveAccount(u);
    const p = await session(browser, u);
    await expect(p.getByRole('link', { name: 'Aprobaciones' })).toHaveCount(0);
    await p.goto('/admin/tipos-permiso');
    await expect(p.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
    await p.goto('/permisos');
    await expect(p.getByLabel('Tipo de permiso')).toBeVisible();
    await expect(p.getByRole('option', { name: `Tipo ${code}` })).toHaveCount(0);
  });
});
