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

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nIde: text('n_ide').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    status: accountStatus('status').notNull().default('PENDIENTE_VERIFICACION'),
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
