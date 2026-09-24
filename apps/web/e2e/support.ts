import { hash, type Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
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
      `truncate audit_logs, verification_codes, sessions, role_assignments, area_manager_assignments,
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
