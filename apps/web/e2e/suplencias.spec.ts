import { expect, test, type Browser, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

async function openAs(browser: Browser, u: SeedUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test.describe('suplencias de quienes aprueban', () => {
  test.beforeEach(async () => {
    await query(`delete from approval_substitutions`);
  });

  test('el jefe designa a su director, ambos ven el aviso, el jefe la termina y Gestión Humana anula otra', async ({
    browser,
  }) => {
    const mgr = newUser('suplejefe');
    await seedActiveAccount(mgr, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: '10300' }]);
    const dir = newUser('supledir');
    await seedActiveAccount(dir, [{ role: 'AREA_DIRECTOR', cEmp: 'GA', areaCode: '10300' }]);
    const emp = newUser('suplemp');
    await seedActiveAccount(emp);
    const admin = await seedAdminUser('HR_ADMIN');

    // un empleado sin rol de aprobación no tiene la pestaña
    const pe = await openAs(browser, emp);
    await pe.goto('/cuenta/suplencias');
    await expect(pe.getByText('No tiene un rol que apruebe solicitudes.')).toBeVisible();
    await pe.context().close();

    const pm = await openAs(browser, mgr);
    await pm.goto('/cuenta/clave');
    await pm
      .getByRole('navigation', { name: 'Mi cuenta' })
      .getByRole('link', { name: 'Mis suplencias' })
      .click();
    await expect(pm.getByRole('heading', { level: 1, name: 'Mis suplencias' })).toBeVisible();

    // el formulario valida antes de enviar y ofrece solo aprobadores de la misma empresa
    await pm.getByRole('button', { name: 'Designar suplente' }).click();
    await expect(pm.getByText('Elija a la persona que lo suplirá.')).toBeVisible();
    const options = await pm.getByLabel('Quién lo suplirá').locator('option').allTextContents();
    expect(options.some((o) => o.includes(dir.name))).toBe(true);
    expect(options.some((o) => o.includes(emp.name))).toBe(false);

    await pm.getByLabel('Quién lo suplirá').selectOption({ label: dir.name });
    await pm.getByLabel('Desde').fill(day(0));
    await pm.getByLabel('Hasta').fill(day(91));
    await pm.getByRole('button', { name: 'Designar suplente' }).click();
    await expect(pm.getByText('Una suplencia dura como máximo 90 días.')).toBeVisible();
    await pm.getByLabel('Hasta').fill(day(3));
    await pm.getByRole('button', { name: 'Designar suplente' }).click();
    await expect(pm.getByText(/Suplencia registrada/)).toBeVisible();
    const mine = pm.getByRole('region', { name: 'Suplencias que designé' });
    await expect(mine).toContainText(dir.name);
    await expect(mine).toContainText('Vigente');

    // los dos ven en Aprobaciones quién decide hoy
    await pm.goto('/aprobaciones');
    await expect(pm.getByText(new RegExp(`${dir.name} decide por usted hasta`))).toBeVisible();
    const pd = await openAs(browser, dir);
    await pd.goto('/aprobaciones');
    await expect(pd.getByText(new RegExp(`Hoy decide en suplencia de ${mgr.name}`))).toBeVisible();
    await pd.goto('/cuenta/suplencias');
    await expect(pd.getByRole('region', { name: 'Suplencias en que participo' })).toContainText(
      mgr.name,
    );
    await pd.context().close();

    // el jefe la termina (con confirmación) y vuelve a decidir
    await pm.goto('/cuenta/suplencias');
    await mine.getByRole('button', { name: /^Terminar la suplencia/ }).click();
    await expect(pm.getByText('¿Terminarla?')).toBeVisible();
    await pm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(mine).toContainText('Vigente');
    await mine.getByRole('button', { name: /^Terminar la suplencia/ }).click();
    await pm.getByRole('button', { name: 'Sí, terminar' }).click();
    await expect(pm.getByText(/La suplencia terminó/)).toBeVisible();
    await expect(mine).toContainText('Terminada');
    await pm.goto('/aprobaciones');
    await expect(pm.getByText(/decide por usted hasta/)).toHaveCount(0);

    // otra suplencia, que Gestión Humana anula con motivo
    await pm.goto('/cuenta/suplencias');
    await pm.getByLabel('Quién lo suplirá').selectOption({ label: dir.name });
    await pm.getByLabel('Desde').fill(day(10));
    await pm.getByLabel('Hasta').fill(day(12));
    await pm.getByRole('button', { name: 'Designar suplente' }).click();
    await expect(pm.getByText(/Suplencia registrada/)).toBeVisible();
    await pm.context().close();

    const pa = await openAs(browser, admin);
    await pa.goto('/admin/suplencias');
    await expect(
      pa.getByRole('heading', { level: 1, name: 'Suplencias de quienes aprueban' }),
    ).toBeVisible();
    const table = pa.getByRole('region', { name: 'Suplencias', exact: true });
    await expect(table).toContainText(mgr.name);
    await expect(table).toContainText('Programada');
    await table
      .getByRole('button', { name: new RegExp(`^Anular la suplencia de ${mgr.name}`) })
      .click();
    const dialog = pa.getByRole('dialog');
    await dialog.getByLabel(/Motivo/).fill('corto');
    await dialog.getByRole('button', { name: 'Anular suplencia' }).click();
    await expect(dialog.getByText('Escriba un motivo de al menos 10 caracteres.')).toBeVisible();
    await dialog.getByLabel(/Motivo/).fill('Se designó a la persona equivocada');
    await dialog.getByRole('button', { name: 'Anular suplencia' }).click();
    await expect(pa.getByText(/Suplencia anulada/)).toBeVisible();
    await expect(table).toContainText('Anulada');
    const rows = await query<{ status: string }>(
      `select status from approval_substitutions order by created_at`,
    );
    expect(rows.map((r) => r.status)).toEqual(['TERMINADA', 'ANULADA']);
    await pa.context().close();
  });
});
