import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('archivo histórico en la nube', () => {
  test.beforeEach(async () => {
    await query(`delete from archived_objects`);
    await query(`delete from archive_settings`);
  });

  test('el administrador configura el bucket, ve un error claro al probar y guarda sin mostrar el secreto', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    await login(page, admin);
    await page.goto('/admin/archivo');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Archivo histórico en la nube' }),
    ).toBeVisible();
    const form = page.getByRole('region', { name: 'Configuración del bucket' });
    await expect(form.getByLabel('Nombre del bucket')).toHaveValue('nomflow');
    await expect(form.getByLabel('Región')).toHaveValue('us-central1');
    await expect(form.getByLabel(/Archivar lo que tenga más de/)).toHaveValue('365');

    // datos inválidos
    await form.getByLabel(/Archivar lo que tenga más de/).fill('5');
    await form.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'Revise los datos' })).toBeVisible();

    // un destino inalcanzable: la prueba explica qué revisar
    await form.getByLabel('Dirección del servicio S3').fill('http://127.0.0.1:9');
    await form.getByLabel(/Archivar lo que tenga más de/).fill('365');
    await form.getByLabel('Clave de acceso (HMAC)').fill('GOOG1EXAMPLE');
    await form.getByLabel('Secreto (HMAC)').fill('secreto-de-prueba-123');
    await form.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(page.getByText('Configuración guardada.')).toBeVisible();
    await expect(form.getByText(/Ya hay un secreto guardado/)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('secreto-de-prueba-123');

    await page.getByRole('button', { name: 'Probar conexión' }).click();
    await expect(
      page.locator('p[role="alert"]', { hasText: 'No se pudo llegar al servicio' }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('un certificado archivado avisa al empleado de la demora esperada', async ({ page }) => {
    const emp = newUser('archivo');
    await seedActiveAccount(emp);
    const key = `tax-certificates/e2e-${emp.nIde}.pdf`;
    await query(
      `insert into tax_certificates (n_ide, year, version, object_key, sha256, size_bytes, file_name, uploaded_at)
       values ('${emp.nIde}', 2022, 1, '${key}', 'abc', 100, 'r.pdf', now() - interval '500 days')`,
    );
    await query(
      `insert into archived_objects (object_key, source, status, sha256, size_bytes) values ('${key}', 'TAX_CERT', 'CLOUD', 'abc', 100)`,
    );
    await login(page, emp);
    await page.goto('/retenciones');
    await expect(page.getByText('Año 2022')).toBeVisible();
    await expect(
      page.getByText(/Archivo histórico: la descarga puede tardar unos segundos/),
    ).toBeVisible();
  });
});
