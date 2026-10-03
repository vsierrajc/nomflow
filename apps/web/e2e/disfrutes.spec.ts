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

/** Siembra un disfrute ya aprobado (que descontó 3 de 10 días del período) y devuelve los ids. */
async function seedApproved(emp: SeedUser, adminNIde: string) {
  const [a] = await query<{ id: string }>(`select id from accounts where n_ide = $1`, [emp.nIde]);
  const [period] = await query<{ id: string }>(
    `insert into prog_vac (n_ide, n_cont, per_ini, per_fin, dias, disp)
     values ($1, '1', '2025-01-01', '2025-12-31', 15, 7) returning id`,
    [emp.nIde],
  );
  const [req] = await query<{ id: string }>(
    `insert into vacation_requests (account_id, n_ide, n_cont, c_emp, c_area, manager_account_id, status)
     values ($1, $2, '1', 'GA', '10300', $1, 'APROBADA') returning id`,
    [a?.id, emp.nIde],
  );
  const [rev] = await query<{ id: string }>(
    `insert into vacation_revisions (request_id, number, start_date, end_date, calendar_diff, business_days,
       return_date, counted_days, calendar_ids, proposed_by, content_hash)
     values ($1, 1, $2, $3, 2, 3, $4, '[]'::jsonb, '[]'::jsonb, $5, 'hash-e2e') returning id`,
    [req?.id, day(2), day(4), day(5), a?.id],
  );
  await query(
    `insert into vacation_revision_allocations (revision_id, prog_vac_id, days) values ($1, $2, 3)`,
    [rev?.id, period?.id],
  );
  await query(
    `insert into vacaciones (request_id, revision_id, n_ide, n_cont, fec_ini_dis, fec_fin_dis, dias_dis,
       dias_habiles, fecha_retorno)
     values ($1, $2, $3, '1', $4, $5, 2, 3, $6)`,
    [req?.id, rev?.id, emp.nIde, day(2), day(4), day(5)],
  );
  void adminNIde;
  return { requestId: req?.id ?? '', periodId: period?.id ?? '' };
}

test.describe('disfrutes aprobados', () => {
  test('Gestión Humana anula un disfrute aprobado con motivo y los días vuelven al período', async ({
    page,
  }) => {
    const emp = newUser('disfrute');
    await seedActiveAccount(emp);
    const admin = await seedAdminUser('HR_ADMIN');
    const { requestId, periodId } = await seedApproved(emp, admin.nIde);

    await login(page, admin);
    await page.goto('/admin/disfrutes');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Disfrutes aprobados' }),
    ).toBeVisible();
    await page.getByLabel(/Buscar por nombre/).fill(emp.nIde);
    await page.getByRole('button', { name: 'Filtrar' }).click();
    const table = page.getByRole('region', { name: 'Disfrutes aprobados' });
    await expect(table).toContainText(emp.name);
    await expect(table).toContainText('Aprobado');

    await table
      .getByRole('button', { name: new RegExp(`^Anular el disfrute de ${emp.name}`) })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Se devolverán 3 días hábiles');
    // el motivo corto se rechaza y el error se ve dentro del diálogo
    await dialog.getByLabel(/Motivo/).fill('corto');
    await dialog.getByRole('button', { name: 'Anular disfrute' }).click();
    await expect(dialog.getByText('Escriba un motivo de al menos 10 caracteres.')).toBeVisible();
    await dialog.getByLabel(/Motivo/).fill('Se aprobó con las fechas equivocadas');
    await dialog.getByRole('button', { name: 'Anular disfrute' }).click();
    await expect(page.getByText(/Disfrute anulado\./)).toBeVisible();
    await expect(table).toContainText('Anulado');
    await expect(table).toContainText('fechas equivocadas');
    await expect(table.getByRole('button', { name: /^Anular el disfrute/ })).toHaveCount(0);

    const [p] = await query<{ disp: number }>(`select disp from prog_vac where id = $1`, [
      periodId,
    ]);
    expect(p?.disp).toBe(10); // 7 + 3 devueltos
    const [r] = await query<{ status: string }>(
      `select status from vacation_requests where id = $1`,
      [requestId],
    );
    expect(r?.status).toBe('ANULADA');

    // el filtro por estado separa aprobados y anulados
    await page.getByLabel('Estado').selectOption('APROBADA');
    await expect(page.getByText('No hay disfrutes con esos filtros.')).toBeVisible();
    await page.getByLabel('Estado').selectOption('ANULADA');
    await expect(table).toContainText(emp.name);
  });
});
