import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function accountId(u: SeedUser): Promise<string> {
  const [r] = await query<{ id: string }>(`select id from accounts where n_ide = $1`, [u.nIde]);
  return r?.id ?? '';
}

test.describe('bandeja de entrada', () => {
  // Las solicitudes sembradas no deben quedar para otras pruebas que asumen las tablas vacías.
  test.afterEach(async () => {
    await query(`delete from vacation_revisions`);
    await query(`delete from vacation_requests`);
  });

  test('el jefe ve la solicitud pendiente y el empleado ve en qué paso va', async ({ browser }) => {
    const emp = newUser('bandeja-emp');
    const jefe = newUser('bandeja-jefe');
    await seedActiveAccount(emp);
    await seedActiveAccount(jefe);
    const [e, j] = [await accountId(emp), await accountId(jefe)];
    const [req] = await query<{ id: string }>(
      `insert into vacation_requests (account_id, n_ide, n_cont, c_emp, c_area, manager_account_id, status)
       values ($1, $2, '1', 'GA', 'A1', $3, 'PENDIENTE_JEFE') returning id`,
      [e, emp.nIde, j],
    );
    await query(
      `insert into vacation_revisions (request_id, number, start_date, end_date, calendar_diff, business_days, return_date, counted_days, calendar_ids, proposed_by, content_hash)
       values ($1, 1, '2026-11-02', '2026-11-13', 12, 10, '2026-11-16', '[]', '[]', $2, 'h')`,
      [req?.id, e],
    );

    // Jefe: una actividad pendiente, con insignia en el menú.
    const pj = await (await browser.newContext()).newPage();
    await pj.goto('http://localhost:3100/login');
    await login(pj, jefe);
    const menu = pj.getByRole('navigation', { name: 'Principal' });
    await expect(menu.getByLabel('1 pendientes')).toBeVisible();
    await menu.getByRole('link', { name: /Bandeja de entrada/ }).click();
    await expect(pj.getByRole('heading', { level: 1, name: 'Bandeja de entrada' })).toBeVisible();
    const task = pj.getByTestId('inbox-task');
    await expect(task).toHaveCount(1);
    await expect(task).toContainText('Decidir solicitud de vacaciones');
    await expect(task).toContainText(emp.name);
    await expect(task).toContainText('2026-11-02 a 2026-11-13');
    await task.getByRole('link', { name: 'Abrir' }).click();
    await expect(pj).toHaveURL(/\/aprobaciones/);

    // Empleado: sin actividades, pero con el avance de su solicitud.
    const pe = await (await browser.newContext()).newPage();
    await pe.goto('http://localhost:3100/login');
    await login(pe, emp);
    await expect(pe.getByLabel(/pendientes/)).toHaveCount(0);
    await pe.goto('/bandeja');
    await expect(pe.getByText('No tiene actividades pendientes.')).toBeVisible();
    const flow = pe.getByTestId('inbox-flow');
    await expect(flow).toHaveCount(1);
    await expect(flow).toContainText('Pendiente del jefe de área');
    const steps = flow.getByRole('listitem');
    await expect(steps.filter({ hasText: 'Enviada' })).toContainText('completado');
    await expect(steps.filter({ hasText: 'Jefe de área' })).toContainText('paso actual');
    await expect(steps.filter({ hasText: 'Aprobación final' })).toContainText('pendiente');

    // Al pasar a la aprobación final, el paso actual cambia.
    await query(`update vacation_requests set status = 'PENDIENTE_FINAL' where id = $1`, [req?.id]);
    await pe.reload();
    await expect(
      pe.getByTestId('inbox-flow').getByRole('listitem').filter({ hasText: 'Aprobación final' }),
    ).toContainText('paso actual');
  });
});
