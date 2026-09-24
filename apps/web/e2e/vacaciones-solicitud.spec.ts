import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { newUser, query, seedActiveAccount, uid, type SeedUser } from './support';

async function session(browser: Browser, u: SeedUser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('http://localhost:3100/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
  return page;
}

/** Primer lunes de marzo del año (día hábil sin festivos de prueba). */
function firstMonday(year: number): { start: string; plus2: string } {
  const d = new Date(Date.UTC(year, 2, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const start = iso(d);
  d.setUTCDate(d.getUTCDate() + 2);
  return { start, plus2: iso(d) };
}

async function seedScenario(year: number) {
  const area = `A${uid().toUpperCase()}`;
  const emp = newUser('vsol');
  const mgr = newUser('vjef');
  const fin = newUser('vfin');
  await seedActiveAccount(emp);
  await seedActiveAccount(mgr, [{ role: 'AREA_MANAGER', cEmp: 'GA', areaCode: area }]);
  await seedActiveAccount(fin, [{ role: 'VACATION_FINAL_APPROVER', cEmp: 'GA' }]);
  await query(`update employee_snapshots set c_area = $1 where n_ide = $2`, [area, emp.nIde]);
  await query(`update employee_snapshots set c_area = $1 where n_ide = $2`, [area, mgr.nIde]);
  const [m] = await query<{ id: string }>(`select id from accounts where n_ide = $1`, [mgr.nIde]);
  await query(
    `insert into area_manager_assignments (c_emp, c_area, manager_account_id, valid_from, created_by) values ('GA', $1, $2, '2020-01-01', $2)`,
    [area, m?.id],
  );
  for (const y of [year, year + 1]) {
    const [c] = await query<{ id: string }>(
      `insert into holiday_calendars (year, version, status, source, created_by, published_by, published_at)
       values ($1, 1, 'PUBLICADO', 'MANUAL', $2, $2, now()) returning id`,
      [y, m?.id],
    );
    await query(
      `insert into holidays (calendar_id, date, name) values ($1, $2, 'Festivo de prueba')`,
      [c?.id, `${y}-03-24`],
    );
  }
  await query(
    `insert into prog_vac (n_ide, n_cont, per_ini, per_fin, dias, disp) values ($1, '1', '2029-01-01', '2029-12-31', 15, 10)`,
    [emp.nIde],
  );
  return { emp, mgr, fin };
}

test.describe('solicitud de vacaciones: empleado, jefe y aprobador final', () => {
  test('flujo completo con propuesta de cambio, aceptación y descuento de días', async ({
    browser,
  }) => {
    const year = 2033 + Math.floor(Math.random() * 5);
    const { emp, mgr, fin } = await seedScenario(year);
    const monday = firstMonday(year);
    const e = await session(browser, emp);

    // El empleado calcula, ve la diferencia entre días hábiles y calendario, y envía.
    await e.goto('/vacaciones');
    await expect(e.getByRole('heading', { level: 1, name: 'Mis vacaciones' })).toBeVisible();
    await e.getByLabel(/Período .*: 15 días, 10 disponibles/).fill('5');
    await e.getByLabel('Fecha inicial del disfrute (día hábil)').fill(monday.start);
    await e.getByRole('button', { name: 'Calcular fechas' }).click();
    const calc = e.getByRole('region', { name: 'Fechas calculadas' });
    await expect(calc.getByText('Diferencia en días calendario')).toBeVisible();
    await expect(calc.getByText('Días hábiles (se descuentan de lo disponible)')).toBeVisible();
    await calc.getByRole('button', { name: 'Aceptar y enviar solicitud' }).click();
    await expect(e.getByText('Solicitud enviada.')).toBeVisible();
    await expect(e.getByText('Pendiente del jefe de área').first()).toBeVisible();
    expect(await query(`select disp from prog_vac where n_ide = $1`, [emp.nIde])).toEqual([
      { disp: 10 },
    ]);

    // El jefe propone reducir a 3 días; el empleado acepta.
    const m = await session(browser, mgr);
    await m.goto('/aprobaciones');
    await m.getByRole('button', { name: /Revisar la solicitud de/ }).click();
    await m.getByRole('button', { name: 'Proponer cambios' }).click();
    const propose = m.getByRole('form', { name: 'Proponer cambios' });
    await propose.getByLabel(/Días hábiles del período/).fill('3');
    await propose
      .getByLabel('Motivo del cambio (mínimo 10 caracteres)')
      .fill('Cierre contable en la segunda semana');
    await propose.getByRole('button', { name: 'Enviar propuesta al empleado' }).click();
    await expect(m.getByText('Cambio propuesto.')).toBeVisible();

    await e.goto('/vacaciones');
    await expect(e.getByText('Tiene un cambio propuesto por su jefe')).toBeVisible();
    await e.getByRole('button', { name: 'Aceptar el cambio' }).click();
    await expect(e.getByText('Cambio aceptado.')).toBeVisible();

    // El aprobador final aprueba y se descuentan los días.
    const f = await session(browser, fin);
    await f.goto('/aprobaciones');
    await f.getByRole('button', { name: /Revisar la solicitud de/ }).click();
    await f.getByRole('button', { name: 'Aprobar y descontar' }).click();
    await expect(f.getByText('Aprobación final registrada')).toBeVisible();
    expect(await query(`select disp from prog_vac where n_ide = $1`, [emp.nIde])).toEqual([
      { disp: 7 },
    ]);
    expect(
      await query(
        `select fec_ini_dis::text, fec_fin_dis::text, dias_habiles, dias_dis from vacaciones where n_ide = $1`,
        [emp.nIde],
      ),
    ).toEqual([
      { fec_ini_dis: monday.start, fec_fin_dis: monday.plus2, dias_habiles: 3, dias_dis: 2 },
    ]);
    await e.goto('/vacaciones');
    await expect(e.getByText('Aprobada').first()).toBeVisible();
    await e.getByRole('button', { name: /Ver detalle de la solicitud/ }).click();
    await expect(e.getByRole('heading', { name: 'Revisión 2 (vigente)' })).toBeVisible();
    await expect(e.getByText('Cierre contable en la segunda semana').first()).toBeVisible();

    // Accesibilidad de las tres pantallas.
    for (const [page, path] of [
      [e, '/vacaciones'],
      [m, '/aprobaciones'],
      [f, '/aprobaciones'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const serious = (
        await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
      ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        serious.map((v) => `${v.id}: ${v.help}`),
        path,
      ).toEqual([]);
    }
  });

  test('sin calendario publicado no calcula, y el rechazo no descuenta nada', async ({
    browser,
  }) => {
    const { emp, mgr } = await seedScenario(2040);
    const e = await session(browser, emp);
    await e.goto('/vacaciones');
    await e.getByLabel(/Período .*: 15 días, 10 disponibles/).fill('2');
    await e.getByLabel('Fecha inicial del disfrute (día hábil)').fill('2050-03-01');
    await e.getByRole('button', { name: 'Calcular fechas' }).click();
    await expect(
      e.locator('p[role="alert"]', { hasText: 'calendario de festivos de 2050' }),
    ).toBeVisible();

    await e.getByLabel('Fecha inicial del disfrute (día hábil)').fill('2040-03-05');
    await e.getByRole('button', { name: 'Calcular fechas' }).click();
    await e.getByRole('button', { name: 'Aceptar y enviar solicitud' }).click();
    await expect(e.getByText('Solicitud enviada.')).toBeVisible();

    const m = await session(browser, mgr);
    await m.goto('/aprobaciones');
    await m.getByRole('button', { name: /Revisar la solicitud de/ }).click();
    await m.getByRole('button', { name: 'Rechazar' }).click();
    const form = m.getByRole('form', { name: 'Rechazar solicitud' });
    await form.getByLabel(/Motivo del rechazo/).fill('corto');
    await form.getByRole('button', { name: 'Confirmar rechazo' }).click();
    await expect(m.locator('p[role="alert"]', { hasText: 'Escriba el motivo' })).toBeVisible();
    await form.getByLabel(/Motivo del rechazo/).fill('Coincide con el cierre anual del área');
    await form.getByRole('button', { name: 'Confirmar rechazo' }).click();
    await expect(m.getByText('Solicitud rechazada con su motivo.')).toBeVisible();
    expect(await query(`select disp from prog_vac where n_ide = $1`, [emp.nIde])).toEqual([
      { disp: 10 },
    ]);
    expect(await query(`select 1 from vacaciones where n_ide = $1`, [emp.nIde])).toHaveLength(0);
  });

  test('quien no tiene rol de aprobación no ve la bandeja', async ({ browser }) => {
    const u = newUser('vsinrol');
    await seedActiveAccount(u);
    const p = await session(browser, u);
    await expect(p.getByRole('link', { name: 'Aprobaciones' })).toHaveCount(0);
    await p.goto('/aprobaciones');
    await expect(p.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
  });
});
