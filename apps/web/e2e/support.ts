import { hash, type Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { Client } from 'pg';

export const TEST_DB =
  process.env.E2E_DATABASE_URL ?? 'postgresql://nomflow:nomflow@localhost:5432/nomflow_test';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const API = 'http://localhost:4100';
export const ADMIN = { email: 'admin@e2e.test', password: 'Admin-E2E-Segura-1' };

export const uid = () => randomBytes(4).toString('hex');

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DB });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const hashPassword = (p: string) =>
  hash(p, { algorithm: 2 as Algorithm, memoryCost: 19456, timeCost: 2, parallelism: 1 });

export interface SeedUser {
  nIde: string;
  email: string;
  name: string;
  password: string;
}

export function newUser(prefix: string): SeedUser {
  const id = uid();
  return {
    nIde: `9${Math.floor(Math.random() * 1e8)
      .toString()
      .padStart(8, '0')}`,
    email: `${prefix}-${id}@e2e.test`,
    name: `${prefix.toUpperCase()} ${id.toUpperCase()}`,
    password: `Clave-Inicial-${id}-1`,
  };
}

export async function seedEmployee(u: SeedUser): Promise<void> {
  await withDb((c) =>
    c.query(
      `insert into employee_snapshots (n_ide, n_cont, email, est, nombre, c_emp) values ($1, '1', $2, 'V', $3, 'GA')`,
      [u.nIde, u.email, u.name],
    ),
  );
}

export async function seedActiveAccount(
  u: SeedUser,
  roles: { role: string; cEmp?: string; areaCode?: string }[] = [],
): Promise<void> {
  await seedEmployee(u);
  const passwordHash = await hashPassword(u.password);
  await withDb(async (c) => {
    const res = await c.query(
      `insert into accounts (n_ide, email, password_hash, status, must_change_password)
       values ($1, $2, $3, 'ACTIVA', false) returning id`,
      [u.nIde, u.email, passwordHash],
    );
    for (const r of roles) {
      await c.query(
        `insert into role_assignments (account_id, role, company_code, area_code, valid_from)
         values ($1, $2, $3, $4, '2020-01-01')`,
        [res.rows[0].id, r.role, r.cEmp ?? null, r.areaCode ?? null],
      );
    }
  });
}

export async function resetDatabase(): Promise<void> {
  await withDb((c) =>
    c.query(
      `truncate audit_logs, payroll_download_audit, payroll_lines, payroll_versions, payroll_concepts, import_batch_rows,
       import_batches, company_logos, catalog_entry_history, catalog_entries, companies, verification_codes, sessions, role_assignments, area_manager_assignments,
       accounts, employee_snapshots cascade`,
    ),
  );
  const passwordHash = await hashPassword(ADMIN.password);
  await withDb(async (c) => {
    const res = await c.query(
      `insert into accounts (n_ide, email, password_hash, status, must_change_password)
       values ('ADM-E2E', $1, $2, 'ACTIVA', false) returning id`,
      [ADMIN.email, passwordHash],
    );
    await c.query(
      `insert into role_assignments (account_id, role, valid_from) values ($1, 'HR_ADMIN', '2020-01-01')`,
      [res.rows[0].id],
    );
  });
}

export async function latestCode(to: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const list = (await search.json()) as { messages?: { ID: string }[] };
    const first = list.messages?.[0];
    if (first) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${first.ID}`)).json()) as {
        Text: string;
      };
      const m = /es ([A-Z0-9]{8})\./.exec(msg.Text);
      if (m?.[1]) return m[1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No llegó el código a ${to}`);
}

export async function adminCreateAccount(nIde: string): Promise<{ temporaryPassword: string }> {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const res = await fetch(`${API}/admin/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ nIde }),
  });
  if (res.status !== 201) throw new Error(`alta falló: ${res.status}`);
  return (await res.json()) as { temporaryPassword: string };
}

export async function nextPeriod(): Promise<string> {
  const rows = await query<{ max: string | null }>(
    `select max(per) as max from payroll_versions where per >= '210001'`,
  );
  const last = rows[0]?.max ?? '209912';
  const year = Number(last.slice(0, 4));
  const month = Number(last.slice(4));
  return month === 12 ? `${year + 1}01` : `${year}${String(month + 1).padStart(2, '0')}`;
}

export interface SeedPayLine {
  cCon: string;
  concepto: string;
  dev?: string;
  ded?: string;
  cant?: string;
}

export async function seedPayroll(
  u: SeedUser,
  per: string,
  lines: SeedPayLine[],
  contrato = '1',
): Promise<void> {
  await withDb(async (c) => {
    await c.query(
      `insert into companies (c_emp, nombre, sigla, direccion) values ('GA', 'Grupo Alimentario del Atlantico S.A.', 'GRALCO', 'CL 1 38 121') on conflict do nothing`,
    );
    const admin = await c.query(`select id from accounts where email = $1`, [ADMIN.email]);
    const batch = await c.query(
      `insert into import_batches (type, status, file_hash, source_system, responsible, created_by, row_count)
       values ('NOMINA', 'APLICADO', $1, 'e2e', 'e2e', $2, $3) returning id`,
      [uid() + uid(), admin.rows[0].id, lines.length],
    );
    const version = await c.query(
      `insert into payroll_versions (per, n_liq, version, status, content_hash, batch_id, row_count, total_dev, total_ded)
       values ($1, 1, 1, 'PUBLICADA', $2, $3, $4, 0, 0) returning id`,
      [per, uid() + uid(), batch.rows[0].id, lines.length],
    );
    let i = 0;
    for (const l of lines) {
      await c.query(
        `insert into payroll_lines (version_id, row_index, n_ide, contrato, c_con, concepto, slrio, cant, ded, dev, nombre_origen)
         values ($1, $2, $3, $4, $5, $6, 1500000.5, $7, $8, $9, $10)`,
        [
          version.rows[0].id,
          i++,
          u.nIde,
          contrato,
          l.cCon,
          l.concepto,
          l.cant ?? null,
          l.ded ?? null,
          l.dev ?? null,
          u.name,
        ],
      );
    }
  });
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withDb(async (c) => (await c.query(text, params)).rows as T[]);
}

export async function seedAdminUser(
  role: 'HR_ADMIN' | 'SYSTEM_ADMIN',
  prefix = 'adm',
): Promise<SeedUser> {
  const u = newUser(prefix);
  const passwordHash = await hashPassword(u.password);
  await withDb(async (c) => {
    const res = await c.query(
      `insert into accounts (n_ide, email, password_hash, status, must_change_password)
       values ($1, $2, $3, 'ACTIVA', false) returning id`,
      [u.nIde, u.email, passwordHash],
    );
    await c.query(
      `insert into role_assignments (account_id, role, valid_from) values ($1, $2::role_code, '2020-01-01')`,
      [res.rows[0].id, role],
    );
  });
  return u;
}

export async function seedCompany(cEmp: string, nombre = 'Empresa de prueba'): Promise<void> {
  await withDb((c) =>
    c.query(
      `insert into companies (c_emp, nombre, sigla, direccion) values ($1, $2, 'EP', 'Calle 1') on conflict do nothing`,
      [cEmp, nombre],
    ),
  );
}

export async function seedCatalog(
  type: 'AREA' | 'CCOSTO' | 'CARGO' | 'TIPO_CONTRATO',
  cEmp: string,
  code: string,
  name: string,
): Promise<void> {
  await withDb((c) =>
    c.query(
      `insert into catalog_entries (type, c_emp, code, name) values ($1::catalog_type, $2, $3, $4) on conflict do nothing`,
      [type, type === 'TIPO_CONTRATO' ? '' : cEmp, code, name],
    ),
  );
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function pngBuffer(
  width: number,
  height: number,
  rgb: [number, number, number] = [200, 30, 30],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function xlsxBuffer(
  columns: string[],
  rows: (string | number | Date | null)[][],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(columns);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const xlsxFile = (name: string, buffer: Buffer) => ({
  name,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buffer,
});
