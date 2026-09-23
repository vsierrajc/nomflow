import { sql } from 'drizzle-orm';
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
  boolean,
  integer,
  numeric,
  primaryKey,
  jsonb,
} from 'drizzle-orm/pg-core';

export const accountStatus = pgEnum('account_status', [
  'PENDIENTE_VERIFICACION',
  'ACTIVA',
  'BLOQUEADA',
]);

export const roleCode = pgEnum('role_code', [
  'EMPLOYEE',
  'AREA_MANAGER',
  'VACATION_FINAL_APPROVER',
  'CERTIFICATE_APPROVER',
  'HR_ADMIN',
  'SYSTEM_ADMIN',
]);

export const employmentStatus = pgEnum('employment_status', ['V', 'C']);

export const employeeSnapshots = pgTable(
  'employee_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importBatchId: text('import_batch_id'),
    nIde: text('n_ide').notNull(),
    nCont: text('n_cont').notNull(),
    email: text('email').notNull(),
    est: employmentStatus('est').notNull(),
    cEmp: text('c_emp'),
    nombre: text('nombre'),
    cCos: text('c_cos'),
    cCosto: text('c_costo'),
    sAct: numeric('s_act', { precision: 18, scale: 6 }),
    cCar: text('c_car'),
    cArea: text('c_area'),
    fecNac: date('fec_nac'),
    cargo: text('cargo'),
    area: text('area'),
    hliq: text('hliq'),
    sexo: text('sexo'),
    fIni: date('f_ini'),
    turno: text('turno'),
    nombres: text('nombres'),
    apellidos: text('apellidos'),
    celular: text('celular'),
    profesion: text('profesion'),
    nivelEducativo: text('nivel_educativo'),
    tipoContrato: text('tipo_contrato'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('employee_snapshots_contract_uq').on(t.nIde, t.nCont),
    uniqueIndex('employee_snapshots_one_active_uq')
      .on(t.nIde)
      .where(sql`${t.est} = 'V'`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nIde: text('n_ide').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    status: accountStatus('status').notNull().default('PENDIENTE_VERIFICACION'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_email_active_uq')
      .on(t.email)
      .where(sql`${t.status} <> 'BLOQUEADA'`),
    uniqueIndex('accounts_n_ide_active_uq')
      .on(t.nIde)
      .where(sql`${t.status} <> 'BLOQUEADA'`),
  ],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    role: roleCode('role').notNull(),
    companyCode: text('company_code'),
    areaCode: text('area_code'),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
  },
  (t) => [index('role_assignments_account_idx').on(t.accountId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorAccountId: uuid('actor_account_id'),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    resourceId: text('resource_id'),
    result: text('result').notNull(),
    context: jsonb('context').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_at_idx').on(t.at)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    reauthAt: timestamp('reauth_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    index('sessions_account_idx').on(t.accountId),
  ],
);

export const verificationCodes = pgTable(
  'verification_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('verification_codes_account_idx').on(t.accountId, t.createdAt)],
);

export const importStatus = pgEnum('import_status', [
  'RECIBIDO',
  'VALIDANDO',
  'OBSERVADO',
  'LISTO',
  'APLICANDO',
  'APLICADO',
  'FALLIDO',
]);

export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    status: importStatus('status').notNull().default('RECIBIDO'),
    fileHash: text('file_hash').notNull(),
    fileName: text('file_name'),
    sheetName: text('sheet_name'),
    sourceSystem: text('source_system').notNull(),
    responsible: text('responsible').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => accounts.id),
    confirmedBy: uuid('confirmed_by').references(() => accounts.id),
    rowCount: integer('row_count').notNull().default(0),
    stats: jsonb('stats').notNull().default({}),
    errors: jsonb('errors').notNull().default([]),
    errorCount: integer('error_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [index('import_batches_type_hash_idx').on(t.type, t.fileHash)],
);

export const importBatchRows = pgTable(
  'import_batch_rows',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id),
    rowNumber: integer('row_number').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.rowNumber] })],
);

export const catalogType = pgEnum('catalog_type', ['AREA', 'CCOSTO', 'CARGO', 'TIPO_CONTRATO']);

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cEmp: text('c_emp').notNull(),
    nombre: text('nombre').notNull(),
    sigla: text('sigla').notNull(),
    direccion: text('direccion').notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('companies_c_emp_uq').on(t.cEmp)],
);

export const catalogEntries = pgTable(
  'catalog_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: catalogType('type').notNull(),
    cEmp: text('c_emp').notNull().default(''),
    code: text('code').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    batchId: text('batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('catalog_entries_key_uq').on(t.type, t.cEmp, t.code)],
);

export const catalogEntryHistory = pgTable(
  'catalog_entry_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => catalogEntries.id),
    oldName: text('old_name').notNull(),
    newName: text('new_name').notNull(),
    batchId: text('batch_id'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('catalog_entry_history_entry_idx').on(t.entryId)],
);
