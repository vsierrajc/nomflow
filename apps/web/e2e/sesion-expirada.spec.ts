import { expect, test } from '@playwright/test';
import { query, seedAdminUser } from './support';

test('si la sesión caduca, la aplicación lleva al ingreso con un aviso claro (no un falso error de conexión)', async ({
  page,
}) => {
  const admin = await seedAdminUser('HR_ADMIN');
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(admin.email);
  await page.getByLabel('Clave', { exact: true }).fill(admin.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/admin/certificados-emitidos');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Certificados laborales emitidos' }),
  ).toBeVisible();

  // la sesión se revoca (caducó por inactividad o se cerró en otro lugar) con la pantalla abierta
  await query(
    `update sessions set revoked_at = now() where account_id = (select id from accounts where email = $1)`,
    [admin.email],
  );
  // cambiar un filtro obliga a pedir datos de nuevo
  await page.getByLabel('Tipo').selectOption('GENERAL');
  await expect(page).toHaveURL(/\/login\?expirada=1/);
  await expect(page.getByText(/Su sesión expiró por inactividad/)).toBeVisible();
  await expect(page.getByText('No se pudo conectar con el servidor')).toHaveCount(0);
});
