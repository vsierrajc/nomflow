import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const accountId = async (u: SeedUser) =>
  (await query<{ id: string }>(`select id from accounts where n_ide = $1`, [u.nIde]))[0]?.id ?? '';

test.describe('solicitudes pendientes del primer visto bueno', () => {
  test('Gestión Humana reasigna la solicitud atada a un jefe que ya no es el del área', async ({
    page,
  }) => {
    const emp = newUser('empleado');
    const oldMgr = newUser('jefeviejo');
    const newMgr = newUser('jefenuevo');
    await seedActiveAccount(emp);
    await seedActiveAccount(oldMgr);
    await seedActiveAccount(newMgr);
    const admin = await seedAdminUser('HR_ADMIN');
    const [empId, oldId, newId, adminId] = [
      await accountId(emp),
      await accountId(oldMgr),
      await accountId(newMgr),
      await accountId(admin),
    ];
    // el área tenía al jefe viejo; hoy tiene al nuevo
    await query(
      `insert into area_manager_assignments (c_emp, c_area, manager_account_id, valid_from, valid_to, created_by)
       values ('GA', '10300', $1, '2020-01-01', '2020-06-30', $3), ('GA', '10300', $2, '2020-07-01', null, $3)`,
      [oldId, newId, adminId],
    );
    const [req] = await query<{ id: string }>(
      `insert into vacation_requests (account_id, n_ide, n_cont, c_emp, c_area, manager_account_id, status)
       values ($1, $2, '1', 'GA', '10300', $3, 'PENDIENTE_JEFE') returning id`,
      [empId, emp.nIde, oldId],
    );
    await query(
      `insert into vacation_revisions (request_id, number, start_date, end_date, calendar_diff, business_days,
         return_date, counted_days, calendar_ids, proposed_by, content_hash)
       values ($1, 1, $2, $3, 2, 3, $4, '[]'::jsonb, '[]'::jsonb, $5, 'hash-e2e')`,
      [req?.id, day(20), day(22), day(23), empId],
    );

    await login(page, admin);
    await page.goto('/admin/solicitudes-pendientes');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Solicitudes pendientes del primer visto bueno',
      }),
    ).toBeVisible();

    const table = page.getByRole('region', {
      name: 'Solicitudes pendientes del primer visto bueno',
    });
    await expect(table).toContainText(emp.name);
    await expect(table).toContainText(oldMgr.name);
    await expect(table).toContainText(newMgr.name);
    await expect(table).toContainText('Aprobador cambió');
    const serious = (
      await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => v.id)).toEqual([]);

    await table
      .getByRole('button', { name: `Reasignar la solicitud de ${emp.name} a ${newMgr.name}` })
      .click();
    await expect(page.getByText(`pasó a ${newMgr.name}`)).toBeVisible();
    await expect(table).toContainText('Al día');
    await expect(table.getByRole('button', { name: /^Reasignar/ })).toHaveCount(0);

    const [r] = await query<{ manager_account_id: string; first_approver_role: string }>(
      `select manager_account_id, first_approver_role from vacation_requests where id = $1`,
      [req?.id],
    );
    expect(r).toEqual({ manager_account_id: newId, first_approver_role: 'AREA_MANAGER' });
    const actions = await query<{ action: string }>(
      `select action from vacation_actions where request_id = $1`,
      [req?.id],
    );
    expect(actions).toEqual([{ action: 'REASIGNAR' }]);
  });
});
