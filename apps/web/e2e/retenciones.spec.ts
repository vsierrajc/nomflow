import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUser, query, seedActiveAccount, seedAdminUser, type SeedUser } from './support';

/** Misma carpeta que configura playwright.config.ts para la API. */
const INBOX = join(tmpdir(), 'nomflow-e2e-certificados');
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`);

async function login(page: Page, u: SeedUser) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(u.email);
  await page.getByLabel('Clave', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe('certificados de retención en el almacén de objetos', () => {
  test.beforeEach(async () => {
    await rm(INBOX, { recursive: true, force: true });
    await mkdir(INBOX, { recursive: true });
  });

  test('el administrador procesa la carpeta y el empleado descarga su certificado', async ({
    browser,
  }) => {
    const admin = await seedAdminUser('HR_ADMIN');
    const emp = newUser('retencion');
    const other = newUser('retencion');
    await seedActiveAccount(emp);
    await seedActiveAccount(other);
    const year = 2024;
    await writeFile(join(INBOX, `${emp.nIde}_${year}.pdf`), pdf(`certificado-de-${emp.nIde}`));
    await writeFile(join(INBOX, `${other.nIde}_${year}.pdf`), pdf(`certificado-de-${other.nIde}`));
    await writeFile(join(INBOX, 'sin-formato.pdf'), pdf('x'));

    const a = await (await browser.newContext()).newPage();
    await a.goto('http://localhost:3100/login');
    await login(a, admin);
    await a.goto('/admin/retenciones');
    await a.getByRole('button', { name: 'Procesar carpeta' }).click();
    const results = a.getByRole('list', { name: 'Resultado del proceso' });
    await expect(results.getByText(new RegExp(`${emp.nIde}_${year}.pdf: Cargado`))).toBeVisible();
    await expect(results.getByText(/sin-formato.pdf: Nombre inválido/)).toBeVisible();

    // En la base solo quedan el nombre del objeto y la huella; el PDF vive en Garage
    const rows = await query<{ object_key: string | null; has_data: boolean }>(
      `select object_key, data is not null as has_data from tax_certificates where n_ide = $1`,
      [emp.nIde],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.has_data).toBe(false);
    expect(rows[0]?.object_key).toMatch(/^tax-certificates\/[0-9a-f-]{36}\.pdf$/);

    const e = await (await browser.newContext()).newPage();
    await e.goto('http://localhost:3100/login');
    await login(e, emp);
    await e.goto('/retenciones');
    await expect(e.getByText(`Año ${year}`)).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page: e }).withTags(['wcag2a', 'wcag2aa']).analyze()
      ).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
    const res = await e.request.get(`/api/me/tax-certificates/${year}/pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/pdf');
    const body = await res.body();
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.toString()).toContain(`certificado-de-${emp.nIde}`); // el suyo
    expect(body.toString()).not.toContain(`certificado-de-${other.nIde}`); // nunca el de otra persona
    expect((await e.request.get(`/api/me/tax-certificates/2020/pdf`)).status()).toBe(404);
  });
});
