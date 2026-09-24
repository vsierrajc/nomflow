import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  newUser,
  query,
  seedActiveAccount,
  seedAdminUser,
  seedEmployee,
  xlsxBuffer,
  xlsxFile,
  type SeedUser,
} from './support';

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

const COLS = ['N_IDE', 'N_CONT', 'PER_INI', 'PER_FIN', 'DIAS', 'DISP', 'EST'];

test.describe('períodos de vacaciones (PROG_VAC) y festivos', () => {
  test('carga Excel con vista previa, y CRUD completo del administrador', async ({ page }) => {
    await login(page, await seedAdminUser('HR_ADMIN'));
    const emp = newUser('vac');
    await seedEmployee(emp);
    await page.goto('/admin/vacaciones');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Períodos de vacaciones' }),
    ).toBeVisible();
    const section = page.getByRole('region', { name: /Importar períodos desde Excel/ });
    const file = section.getByLabel('Archivo Excel (.xlsx)');

    // 1) archivo con errores: se informa y no se puede aplicar
    await file.setInputFiles(
      xlsxFile(
        'PROG_VAC.xlsx',
        await xlsxBuffer(COLS, [[emp.nIde, '1', '01/01/2025', '31/12/2025', 15, 16, 'A']]),
      ),
    );
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByRole('row', { name: /DISP <= DIAS <= 15/ })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Aplicar importación' })).toHaveCount(0);

    // 2) archivo válido con la estructura de la muestra (fechas DD/MM/AAAA)
    await file.setInputFiles(
      xlsxFile(
        'PROG_VAC2.xlsx',
        await xlsxBuffer(COLS, [
          [emp.nIde, '1', '01/01/2024', '31/12/2024', 15, 5, 'A'],
          [emp.nIde, '1', '01/01/2025', '31/12/2025', 15, 15, 'A'],
        ]),
      ),
    );
    await section.getByLabel('Fecha de corte (AAAA-MM-DD)').fill('2026-09-01');
    await section.getByRole('button', { name: 'Validar archivo' }).click();
    await expect(section.getByText('Lista para aplicar')).toBeVisible();
    await expect(section.getByText('Registros nuevos')).toBeVisible();
    expect(await query(`select 1 from prog_vac where n_ide = $1`, [emp.nIde])).toHaveLength(0);
    await section.getByRole('button', { name: 'Aplicar importación' }).click();
    await expect(section.getByText('Importación aplicada correctamente.')).toBeVisible();
    expect(
      await query(
        `select disp, estado, fecha_corte::text from prog_vac where n_ide = $1 order by per_ini`,
        [emp.nIde],
      ),
    ).toEqual([
      { disp: 5, estado: 'ACTIVA', fecha_corte: '2026-09-01' },
      { disp: 15, estado: 'ACTIVA', fecha_corte: '2026-09-01' },
    ]);

    // 3) el listado y el filtro
    await page.getByLabel('Filtrar por identificación').fill(emp.nIde);
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(
      page.getByRole('row', { name: new RegExp(`${emp.nIde}.*2024-01-01 a 2024-12-31`) }),
    ).toBeVisible();

    // 4) ajuste con motivo: deja el período liquidado y versionado
    await page
      .getByRole('button', {
        name: new RegExp(`Ajustar período 2024-01-01 a 2024-12-31 del empleado ${emp.nIde}`),
      })
      .click();
    const adjust = page.getByRole('region', { name: 'Ajustar período' });
    await adjust.getByLabel('Días disponibles').fill('0');
    await adjust.getByLabel('Motivo (mínimo 10 caracteres)').fill('corto');
    await adjust.getByRole('button', { name: 'Guardar ajuste' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'Revise los datos' })).toBeVisible();
    await adjust
      .getByLabel('Motivo (mínimo 10 caracteres)')
      .fill('Disfrute tomado fuera del portal');
    await adjust.getByRole('button', { name: 'Guardar ajuste' }).click();
    await expect(page.getByText('Ajuste registrado con su motivo')).toBeVisible();
    expect(
      await query(
        `select estado, version, disp from prog_vac where n_ide = $1 and per_ini = '2024-01-01'`,
        [emp.nIde],
      ),
    ).toEqual([{ estado: 'LIQUIDADA', version: 2, disp: 0 }]);

    // 5) alta manual, duplicado y baja
    const create = page.getByRole('region', { name: 'Nuevo período' });
    const fill = async () => {
      await create.getByLabel('Identificación (N_IDE)').fill(emp.nIde);
      await create.getByLabel('Contrato (N_CONT)').fill('1');
      await create.getByLabel('Inicio del período').fill('2026-01-01');
      await create.getByLabel('Fin del período').fill('2026-12-31');
      await create.getByLabel('Días hábiles programados (máx. 15)').fill('15');
      await create.getByLabel('Días hábiles disponibles').fill('15');
      await create.getByRole('button', { name: 'Crear período' }).click();
    };
    await fill();
    await expect(page.getByText('Período creado.')).toBeVisible();
    await fill();
    await expect(page.locator('p[role="alert"]', { hasText: 'ya existe' })).toBeVisible();
    await page
      .getByRole('button', {
        name: new RegExp(`Dar de baja período 2026-01-01 a 2026-12-31 del empleado ${emp.nIde}`),
      })
      .click();
    await expect(page.getByText('Período dado de baja.')).toBeVisible();
    expect(
      await query(`select active from prog_vac where n_ide = $1 and per_ini = '2026-01-01'`, [
        emp.nIde,
      ]),
    ).toEqual([{ active: false }]);
  });

  test('festivos: borrador, publicación y versión reemplazada', async ({ page }) => {
    await login(page, await seedAdminUser('HR_ADMIN'));
    await page.goto('/admin/festivos');
    const year = 2090 + Math.floor(Math.random() * 9);
    const fill = async (line: string) => {
      await page.getByLabel('Año', { exact: true }).fill(String(year));
      await page.getByLabel('Motivo (mínimo 10 caracteres)').fill('Calendario oficial de prueba');
      await page.getByLabel('Festivos (uno por línea: AAAA-MM-DD;Nombre)').fill(line);
      await page.getByRole('button', { name: 'Crear borrador' }).click();
      await expect(page.getByText('Borrador creado.')).toBeVisible();
    };
    await page.getByLabel('Año', { exact: true }).fill(String(year));
    await page.getByLabel('Motivo (mínimo 10 caracteres)').fill('Calendario oficial de prueba');
    await page.getByLabel('Festivos (uno por línea: AAAA-MM-DD;Nombre)').fill('sin formato');
    await page.getByRole('button', { name: 'Crear borrador' }).click();
    await expect(page.locator('p[role="alert"]', { hasText: 'AAAA-MM-DD;Nombre' })).toBeVisible();

    await fill(`${year}-01-01;Año Nuevo`);
    await page
      .getByRole('button', { name: new RegExp(`Publicar calendario ${year}, versión 1`) })
      .click();
    await expect(page.getByText('Calendario publicado.')).toBeVisible();
    await page
      .getByRole('button', {
        name: new RegExp(`Ver los festivos del calendario ${year}, versión 1`),
      })
      .click();
    const shown = page.getByRole('region', { name: 'Festivos del calendario' });
    await expect(shown.getByRole('row', { name: /01\/01\/\d{4}.*Año Nuevo/ })).toBeVisible();
    await shown.getByRole('button', { name: 'Cerrar' }).click();
    await fill(`${year}-01-01;Año Nuevo\n${year}-05-01;Día del Trabajo`);
    await page
      .getByRole('button', {
        name: new RegExp(`Ver los festivos del calendario ${year}, versión 2`),
      })
      .click();
    await expect(shown.getByText(/Nuevo: .*01\/05\/\d{4} - Día del Trabajo/)).toBeVisible();
    await expect(
      shown.getByText('Diferencias con el calendario publicado (versión 1):'),
    ).toBeVisible();
    await shown.getByRole('button', { name: 'Cerrar' }).click();
    await page
      .getByRole('button', { name: new RegExp(`Publicar calendario ${year}, versión 2`) })
      .click();
    await expect(page.getByText('Calendario publicado.')).toBeVisible();
    expect(
      await query(
        `select version, status from holiday_calendars where year = $1 order by version`,
        [year],
      ),
    ).toEqual([
      { version: 1, status: 'REEMPLAZADO' },
      { version: 2, status: 'PUBLICADO' },
    ]);
  });

  test('API de festivos: configuración sin exponer la clave, consulta y error del servicio', async ({
    page,
  }) => {
    const KEY = `clave-e2e-${Date.now()}`;
    const year = 2060 + Math.floor(Math.random() * 8);
    let status = 200;
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { date: `${year}-01-01`, name_es: 'Año Nuevo' },
            { date: `${year}-05-01`, name_es: 'Día del Trabajo' },
          ],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/festivos`;
    try {
      await login(page, await seedAdminUser('HR_ADMIN'));
      await page.goto('/admin/festivos');
      const section = page.getByRole('region', { name: 'Servicio de festivos (API)' });
      await expect(section.getByText('Sin configurar.')).toBeVisible();
      await expect(section.getByRole('button', { name: 'Consultar el año' })).toBeDisabled();

      await section.getByLabel('URL del servicio (sin el año)').fill('ftp://x.co/festivos');
      await section.getByLabel('Clave del servicio (API KEY)').fill(KEY);
      await section.getByRole('button', { name: 'Guardar configuración' }).click();
      await expect(
        section.locator('p[role="alert"]', { hasText: 'La URL no es válida' }),
      ).toBeVisible();

      await section.getByLabel('URL del servicio (sin el año)').fill(url);
      await section.getByLabel('Clave del servicio (API KEY)').fill(KEY);
      await section.getByRole('button', { name: 'Guardar configuración' }).click();
      await expect(section.getByText('Configuración guardada.')).toBeVisible();
      await expect(section.getByText(/URL configurada; clave guardada\./)).toBeVisible();
      // La clave no vuelve al navegador: ni en el campo ni en el texto de la página.
      await expect(section.getByLabel('Clave del servicio (API KEY)')).toHaveValue('');
      expect(await page.content()).not.toContain(KEY);

      await section.getByLabel('Año a consultar').fill(String(year));
      await section.getByRole('button', { name: 'Consultar el año' }).click();
      await expect(
        section.getByText(`Borrador versión 1 del año ${year}: 2 festivos.`),
      ).toBeVisible();
      expect(seen).toEqual([`Bearer ${KEY}`]);
      await expect(
        page.getByRole('row', { name: new RegExp(`${year}.*Borrador.*API`) }),
      ).toBeVisible();
      expect(
        await query(`select status, source from holiday_calendars where year = $1`, [year]),
      ).toEqual([{ status: 'BORRADOR', source: 'API' }]);

      status = 401;
      await section.getByRole('button', { name: 'Consultar el año' }).click();
      await expect(
        section.locator('p[role="alert"]', { hasText: 'El servicio rechazó la clave' }),
      ).toBeVisible();
      await expect(section.getByText('La clave fue rechazada por el servicio')).toBeVisible();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('un empleado no accede a las pantallas de gestión', async ({ page }) => {
    const emp = newUser('sinacceso');
    await seedActiveAccount(emp);
    await login(page, emp);
    for (const path of ['/admin/vacaciones', '/admin/festivos']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Acceso restringido' })).toBeVisible();
    }
  });
});
