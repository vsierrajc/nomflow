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
