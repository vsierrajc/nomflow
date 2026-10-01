import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedAdminUser, seedEmployee, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('retención de datos', () => {
  test('el administrador ajusta plazos y borra certificados solo de una persona dada de baja', async ({
    page,
  }) => {
    await query(`delete from audit_logs where action = 'DATA_RETENTION_PURGE'`);
    const admin = await seedAdminUser('HR_ADMIN');
    const baja = newUser('baja');
    await seedEmployee(baja);
    await query(`update employee_snapshots set est = 'C' where n_ide = $1`, [baja.nIde]);
    const activo = newUser('activo');
    await seedEmployee(activo);
    for (const u of [baja, activo]) {
      await query(
        `insert into tax_certificates (n_ide, year, version, data, sha256, size_bytes, file_name)
         values ($1, 2025, 1, '\\x25504446'::bytea, 'x', 4, 'c.pdf')`,
        [u.nIde],
      );
    }

    await login(page, admin);
    await page.goto('/admin/retencion');
    await expect(page.getByRole('heading', { level: 1, name: 'Retención de datos' })).toBeVisible();

    const plazos = page.getByRole('region', { name: 'Política de retención de datos' });
    await plazos.getByLabel(/Conservar sesiones vencidas/).fill('7');
    await plazos.getByRole('button', { name: 'Guardar plazos' }).click();
    await expect(page.getByText('Política guardada.')).toBeVisible();

    // historial: tras «Depurar ahora» aparece la ejecución manual
    const historial = page.getByRole('region', { name: 'Últimas depuraciones' });
    await expect(historial.getByText('Aún no se ha depurado nada.')).toBeVisible();
    await plazos.getByRole('button', { name: 'Depurar ahora' }).click();
    await expect(page.getByText(/Depuración hecha:/)).toBeVisible();
    await expect(
      historial.getByRole('region', { name: 'Historial de depuraciones' }),
    ).toContainText('Manual');

    const certs = page.getByRole('region', { name: 'Certificados de retención de una persona' });

    // activo: se consulta pero no se ofrece borrar
    await certs.getByLabel('Número de identificación').fill(activo.nIde);
    await certs.getByRole('button', { name: 'Consultar' }).click();
    await expect(certs.getByText('La persona sigue activa')).toBeVisible();
    await expect(certs.getByRole('button', { name: 'Borrar certificados' })).toHaveCount(0);

    // dada de baja: advertencia de ZIP sin descargar y confirmación exacta
    await certs.getByLabel('Número de identificación').fill(baja.nIde);
    await certs.getByRole('button', { name: 'Consultar' }).click();
    await expect(certs.getByText('Nadie ha descargado el ZIP')).toBeVisible();
    await certs.getByLabel(/Repita el número/).fill('otro');
    await certs.getByRole('button', { name: 'Borrar certificados' }).click();
    await expect(page.getByText('no coincide')).toBeVisible();
    await certs.getByLabel(/Repita el número/).fill(baja.nIde);
    await certs.getByRole('button', { name: 'Borrar certificados' }).click();
    await expect(page.getByText(/Se borraron 1 certificado/)).toBeVisible();

    const left = await query<{ n_ide: string }>(
      `select n_ide from tax_certificates where n_ide = any($1)`,
      [[baja.nIde, activo.nIde]],
    );
    expect(left.map((r) => r.n_ide)).toEqual([activo.nIde]);
  });
});
