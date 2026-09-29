import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

/** Fecha dentro de los próximos `days` días, en formato AAAA-MM-DD. */
function soon(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('bajas y exportación de documentos', () => {
  test.beforeEach(async () => {
    await query(`delete from document_export_downloads`);
    await query(`delete from document_exports`);
    await query(`delete from employee_exit_schedules`);
    await query(`delete from exit_settings`);
  });

  test('un empleado no ve la administración de bajas', async ({ page }) => {
    const u = newUser('baja');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/admin/bajas');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });

  test('el administrador configura el plazo, programa una baja y no puede duplicarla', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const emp = newUser('baja');
    await seedActiveAccount(emp);
    await login(page, admin);
    await page.goto('/admin/bajas');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Bajas y exportación de documentos' }),
    ).toBeVisible();

    const settings = page.getByRole('region', { name: 'Plazo de aviso' });
    await expect(settings.getByLabel(/Días de aviso previo/)).toHaveValue('15');
    await settings.getByLabel(/Días de aviso previo/).fill('20');
    await settings.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Plazo de aviso' }).getByLabel(/Días de aviso previo/),
    ).toHaveValue('20');

    const form = page.getByRole('region', { name: 'Programar baja' });
    await form.getByLabel('N_IDE del empleado').fill(emp.nIde);
    await form.getByLabel('Fecha prevista de baja').fill('2027-01-15');
    await form.getByLabel('Motivo').fill('Fin de contrato acordado con el área.');
    await form.getByRole('button', { name: 'Programar' }).click();
    await expect(page.getByText('Baja programada.')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(emp.nIde) });
    await expect(row).toContainText('PENDIENTE');
    await expect(row).toContainText('2027-01-15');

    // segunda baja del mismo empleado: se rechaza mientras la primera siga activa
    await form.getByLabel('N_IDE del empleado').fill(emp.nIde);
    await form.getByLabel('Fecha prevista de baja').fill('2027-02-01');
    await form.getByLabel('Motivo').fill('Segundo intento sobre el mismo empleado.');
    await form.getByRole('button', { name: 'Programar' }).click();
    await expect(
      page.getByText('Ese empleado ya tiene una baja programada o avisada.'),
    ).toBeVisible();
  });

  test('cancelar una baja exige motivo y la retira de las activas', async ({ page }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const emp = newUser('baja');
    await seedActiveAccount(emp);
    await login(page, admin);
    await page.goto('/admin/bajas');

    const form = page.getByRole('region', { name: 'Programar baja' });
    await form.getByLabel('N_IDE del empleado').fill(emp.nIde);
    await form.getByLabel('Fecha prevista de baja').fill('2027-01-15');
    await form.getByLabel('Motivo').fill('Fin de contrato acordado con el área.');
    await form.getByRole('button', { name: 'Programar' }).click();
    await expect(page.getByText('Baja programada.')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(emp.nIde) });
    await row.getByRole('button', { name: 'Cancelar' }).click();
    const modal = page.getByRole('dialog', { name: `Cancelar la baja de ${emp.nIde}` });
    await modal.getByRole('button', { name: 'Confirmar cancelación' }).click();
    await expect(modal.getByText('Escriba un motivo de al menos 10 caracteres.')).toBeVisible();

    await modal.getByLabel(/Motivo/).fill('Se retracta Gestión Humana.');
    await modal.getByRole('button', { name: 'Confirmar cancelación' }).click();
    await expect(page.getByText('Baja cancelada.')).toBeVisible();
    await expect(row).toContainText('CANCELADO');
    await expect(row.getByRole('button', { name: 'Cancelar' })).toHaveCount(0);
  });

  test('el aviso se envía al revisar ahora y la exportación se arma al generar ahora', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const emp = newUser('baja');
    await seedActiveAccount(emp);
    await login(page, admin);
    await page.goto('/admin/bajas');

    // plazo máximo para que una fecha cercana quede siempre dentro del aviso
    const settings = page.getByRole('region', { name: 'Plazo de aviso' });
    await settings.getByLabel(/Días de aviso previo/).fill('90');
    await settings.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();

    const form = page.getByRole('region', { name: 'Programar baja' });
    await form.getByLabel('N_IDE del empleado').fill(emp.nIde);
    await form.getByLabel('Fecha prevista de baja').fill(soon(10));
    await form.getByLabel('Motivo').fill('Baja programada dentro del plazo de aviso.');
    await form.getByRole('button', { name: 'Programar' }).click();
    await expect(page.getByText('Baja programada.')).toBeVisible();

    await page.getByRole('button', { name: 'Revisar avisos ahora' }).click();
    await expect(page.getByText('Avisos enviados: 1.')).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(emp.nIde) });
    await expect(row).toContainText('AVISADO');

    await row.getByRole('button', { name: 'Ver' }).click();
    await expect(row).toContainText('PENDIENTE');

    await page.getByRole('button', { name: 'Generar exportaciones pendientes ahora' }).click();
    await expect(page.getByText(/^Exportaciones procesadas: \d+\.$/)).toBeVisible();
    await row.getByRole('button', { name: 'Ver' }).click();
    await expect(row.getByText(/LISTO|INCOMPLETO/)).toBeVisible({ timeout: 15_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('button', { name: 'Descargar' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('baja.zip');

    const rows = await query<{ n: string }>(
      `select count(*)::text as n from document_export_downloads`,
    );
    expect(rows[0]?.n).toBe('1');
  });

  test('la exportación a pedido exige motivo y queda disponible', async ({ page }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const emp = newUser('baja');
    await seedActiveAccount(emp);
    await login(page, admin);
    await page.goto('/admin/bajas');

    const form = page.getByRole('region', { name: 'Programar baja' });
    await form.getByLabel('N_IDE del empleado').fill(emp.nIde);
    await form.getByLabel('Fecha prevista de baja').fill('2027-06-01');
    await form.getByLabel('Motivo').fill('Baja futura, sin aviso aún.');
    await form.getByRole('button', { name: 'Programar' }).click();
    await expect(page.getByText('Baja programada.')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(emp.nIde) });
    await row.getByRole('button', { name: 'Exportar ahora' }).click();
    const modal = page.getByRole('dialog', { name: `Exportar documentos de ${emp.nIde}` });
    await modal.getByRole('button', { name: 'Solicitar exportación' }).click();
    await expect(modal.getByText('Escriba un motivo de al menos 10 caracteres.')).toBeVisible();

    await modal.getByLabel(/Motivo/).fill('Solicitud administrativa con propósito declarado.');
    await modal.getByRole('button', { name: 'Solicitar exportación' }).click();
    await expect(page.getByText('Exportación solicitada.')).toBeVisible();
    await expect(row).toContainText('PENDIENTE');

    const audit = await query<{ context: { nIde: string } }>(
      `select context from audit_logs where action = 'EXIT_EXPORT_REQUEST'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.context).toMatchObject({ nIde: emp.nIde });
  });
});
