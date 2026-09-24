import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser } from './support';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Clave', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('acciones de la lista de empleados con iconos', () => {
  test('ver, corregir y dar de baja son iconos con nombre accesible y ayuda emergente', async ({
    page,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    await login(page, admin.email, admin.password);
    const u = newUser('iconos');
    await seedActiveAccount(u);
    await page.goto('/admin/empleados');
    await page.getByLabel('Buscar por nombre, identificación o correo').fill(u.nIde);
    const row = page.getByRole('row', { name: new RegExp(u.nIde) });
    await expect(row).toContainText('Vigente');

    for (const [name, label] of [
      [/^Ver /, `Ver ${u.name}`],
      [/^Corregir /, `Corregir ${u.name}`],
      [/^Dar de baja /, `Dar de baja ${u.name}`],
    ] as const) {
      const b = row.getByRole('button', { name });
      await expect(b).toHaveAccessibleName(label);
      await expect(b).toHaveAttribute('title', label); // ayuda al pasar el ratón
      await expect(b.locator('svg[aria-hidden="true"]')).toHaveCount(1); // solo el dibujo
      expect((await b.innerText()).trim()).toBe(''); // sin texto visible
      const box = await b.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(36);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
    }

    // siguen funcionando: el ojo abre la ficha, el lápiz el formulario y la papelera la baja
    await row.getByRole('button', { name: /^Ver / }).click();
    await expect(page.getByRole('dialog')).toContainText('Cuenta de acceso');
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await row.getByRole('button', { name: /^Corregir / }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await row.getByRole('button', { name: /^Dar de baja / }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar' }).click();

    // con el empleado cancelado, la papelera pasa a ser «Reactivar» con otro icono
    await query(`update employee_snapshots set est = 'C' where n_ide = $1`, [u.nIde]);
    await page.reload();
    await page.getByLabel('Buscar por nombre, identificación o correo').fill(u.nIde);
    const cancelled = page.getByRole('row', { name: new RegExp(u.nIde) });
    await expect(cancelled.getByRole('button', { name: /^Reactivar / })).toHaveAccessibleName(
      `Reactivar ${u.name}`,
    );
    await expect(cancelled.getByRole('button', { name: /^Dar de baja / })).toHaveCount(0);

    const serious = (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
