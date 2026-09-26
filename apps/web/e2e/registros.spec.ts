import { expect, test, type Page } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

const LOG = join(tmpdir(), 'nomflow-e2e-api.log');

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('registros y depuración', () => {
  test.beforeEach(async () => {
    await query(`delete from audit_logs where resource in ('e2e-old', 'e2e-new')`);
    await writeFile(
      LOG,
      ['inicio de prueba', 'ERROR simulado uno', 'todo bien', 'ERROR simulado dos'].join('\n') +
        '\n',
    );
  });

  test('el administrador ve el resumen, exporta, depura sin copia y vacía un archivo', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    await query(
      `insert into audit_logs (action, resource, result, at) select 'HTTP_REQUEST', 'e2e-old', '200', now() - interval '200 days' from generate_series(1, 3)`,
    );
    await query(
      `insert into audit_logs (action, resource, result, at) values ('HTTP_REQUEST', 'e2e-new', '200', now())`,
    );
    await login(page, admin);
    await page.goto('/admin/registros');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Registros y depuración' }),
    ).toBeVisible();
    const summary = page.getByRole('region', { name: 'Resumen de la auditoría' });
    await expect(summary.getByText('Peticiones HTTP')).toBeVisible();
    await expect(summary.getByText('Eventos de auditoría')).toBeVisible();

    // exportar: el enlace lleva los filtros elegidos
    const box = page.getByRole('region', { name: 'Exportar o enviar al histórico' });
    await box.getByLabel('Qué registros').selectOption('EVENTOS');
    await box.getByLabel('Formato de exportación').selectOption('jsonl');
    await box.getByLabel(/Desde/).fill('2026-01-01');
    await expect(box.getByRole('link', { name: 'Descargar exportación' })).toHaveAttribute(
      'href',
      /kind=EVENTOS&format=jsonl&from=2026-01-01/,
    );

    // depurar sin copia: pide motivo y confirmación
    const purge = page.getByRole('region', { name: 'Depurar la auditoría' });
    await purge.getByLabel('Qué se borra').selectOption('HTTP');
    const before = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    await purge.getByLabel('Borrar lo anterior a').fill(before);
    await purge.getByLabel(/Copiar al histórico en la nube antes de borrar/).uncheck();
    await expect(purge.getByText(/no se puede recuperar/)).toBeVisible();
    await purge.getByLabel(/Motivo/).fill('corto');
    await purge.getByLabel(/Escriba BORRAR/).fill('BORRAR');
    await purge.getByRole('button', { name: 'Depurar ahora' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'Escriba BORRAR' })).toBeVisible();
    await purge.getByLabel(/Motivo/).fill('Limpieza de peticiones antiguas de prueba');
    await purge.getByRole('button', { name: 'Depurar ahora' }).click();
    await expect(
      page.getByText(/Depuración terminada: \d+ registros borrados \(sin copia\)/),
    ).toBeVisible();
    const left = await query<{ resource: string; n: number }>(
      `select resource, count(*)::int n from audit_logs where resource in ('e2e-old','e2e-new') group by resource`,
    );
    expect(left).toEqual([{ resource: 'e2e-new', n: 1 }]); // lo antiguo se fue y lo reciente sigue
    const trace = await query<{ n: number }>(
      `select count(*)::int n from audit_logs where action = 'AUDIT_PURGE'`,
    );
    expect(trace[0]?.n).toBeGreaterThanOrEqual(1); // queda la huella

    // archivos de la aplicación: ver, filtrar y vaciar
    const files = page.getByRole('region', { name: 'Archivos de registro de la aplicación' });
    await files.getByRole('button', { name: 'Ver últimas líneas' }).click();
    await expect(files.getByLabel('Últimas líneas de api')).toContainText('todo bien');
    await files.getByLabel(/Filtrar líneas/).fill('error');
    await files.getByRole('button', { name: 'Ver últimas líneas' }).click();
    await expect(files.getByLabel('Últimas líneas de api')).not.toContainText('todo bien');
    await expect(files.getByLabel('Últimas líneas de api')).toContainText('ERROR simulado dos');
    await files.getByRole('button', { name: 'Vaciar…' }).click();
    const clear = files.getByRole('form', { name: 'Vaciar el archivo' });
    await clear.getByLabel(/Enviar una copia/).uncheck();
    await clear.getByLabel(/Motivo/).fill('Vaciar el registro de la prueba');
    await clear.getByLabel(/Escriba BORRAR/).fill('no');
    await clear.getByRole('button', { name: 'Vaciar el archivo' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'Escriba BORRAR' })).toBeVisible();
    expect((await stat(LOG)).size).toBeGreaterThan(0);
    await clear.getByLabel(/Escriba BORRAR/).fill('BORRAR');
    await clear.getByRole('button', { name: 'Vaciar el archivo' }).click();
    await expect(page.getByText(/Se vació el archivo/)).toBeVisible();
    expect(await readFile(LOG, 'utf8')).toBe('');
  });

  test('un empleado no ve los registros', async ({ page }) => {
    const u = newUser('reg');
    await seedActiveAccount(u);
    await login(page, u);
    await page.goto('/admin/registros');
    await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });
});
