import { sql } from 'drizzle-orm';
import {
  check,
  customType,
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

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

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
    version: integer('version').notNull().default(1),
    source: text('source').notNull().default('IMPORT'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
    /** Verificación en dos pasos opcional: cada ingreso exige además un código enviado al correo. */
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorEnabledAt: timestamp('two_factor_enabled_at', { withTimezone: true }),
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
  (t) => [
    index('audit_logs_at_idx').on(t.at),
    index('audit_logs_actor_at_idx').on(t.actorAccountId, t.at),
    index('audit_logs_action_at_idx').on(t.action, t.at),
  ],
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
    payrollDefaultMode: text('payroll_default_mode').notNull().default('ENTERO_SUPERIOR'),
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
    version: integer('version').notNull().default(1),
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

export const areaManagerAssignments = pgTable(
  'area_manager_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cEmp: text('c_emp').notNull(),
    cArea: text('c_area').notNull(),
    managerAccountId: uuid('manager_account_id')
      .notNull()
      .references(() => accounts.id),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('area_manager_area_idx').on(t.cEmp, t.cArea)],
);

export const payrollVersions = pgTable(
  'payroll_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    per: text('per').notNull(),
    nLiq: integer('n_liq').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    contentHash: text('content_hash').notNull(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id),
    rowCount: integer('row_count').notNull(),
    totalDev: numeric('total_dev', { precision: 18, scale: 6 }).notNull(),
    totalDed: numeric('total_ded', { precision: 18, scale: 6 }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payroll_versions_scope_version_uq').on(t.per, t.nLiq, t.version),
    uniqueIndex('payroll_versions_one_published_uq')
      .on(t.per, t.nLiq)
      .where(sql`${t.status} = 'PUBLICADA'`),
  ],
);

export const payrollLines = pgTable(
  'payroll_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => payrollVersions.id),
    rowIndex: integer('row_index').notNull(),
    nIde: text('n_ide').notNull(),
    contrato: text('contrato').notNull(),
    cCon: text('c_con').notNull(),
    concepto: text('concepto'),
    slrio: numeric('slrio', { precision: 18, scale: 6 }),
    cant: numeric('cant', { precision: 18, scale: 6 }),
    ded: numeric('ded', { precision: 18, scale: 6 }),
    dev: numeric('dev', { precision: 18, scale: 6 }),
    tercero: text('tercero'),
    nombreOrigen: text('nombre_origen'),
  },
  (t) => [
    index('payroll_lines_voucher_idx').on(t.nIde, t.contrato, t.versionId),
    index('payroll_lines_version_idx').on(t.versionId),
  ],
);

export const payrollDownloadAudit = pgTable(
  'payroll_download_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    versionId: uuid('version_id'),
    per: text('per').notNull(),
    nLiq: integer('n_liq').notNull(),
    contrato: text('contrato').notNull(),
    mode: text('mode').notNull(),
    result: text('result').notNull(),
    targetNIde: text('target_n_ide'),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payroll_download_audit_account_idx').on(t.accountId, t.at)],
);

export const payrollConcepts = pgTable(
  'payroll_concepts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    unit: text('unit').notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    batchId: text('batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payroll_concepts_code_uq').on(t.code)],
);

export const companyLogos = pgTable(
  'company_logos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    version: integer('version').notNull(),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
    sha256: text('sha256').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    active: boolean('active').notNull().default(false),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => accounts.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('company_logos_version_uq').on(t.companyId, t.version),
    uniqueIndex('company_logos_one_active_uq')
      .on(t.companyId)
      .where(sql`${t.active} = true`),
  ],
);

export const employeeChanges = pgTable(
  'employee_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employeeSnapshots.id),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => accounts.id),
    action: text('action').notNull(),
    reason: text('reason').notNull(),
    changes: jsonb('changes').notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('employee_changes_employee_idx').on(t.employeeId, t.at)],
);

export const taxCertificates = pgTable(
  'tax_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nIde: text('n_ide').notNull(),
    year: integer('year').notNull(),
    version: integer('version').notNull(),
    /** Certificados anteriores a ADR-003: el PDF vivía en la base. Se pasa a objetos con `storage:migrate`. */
    data: bytea('data'),
    /** Objeto en el almacén (Garage), cifrado por la aplicación. */
    objectKey: text('object_key'),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    fileName: text('file_name').notNull(),
    active: boolean('active').notNull().default(true),
    uploadedBy: uuid('uploaded_by').references(() => accounts.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('tax_certificates_stored_ck', sql`${t.data} is not null or ${t.objectKey} is not null`),
    uniqueIndex('tax_certificates_version_uq').on(t.nIde, t.year, t.version),
    uniqueIndex('tax_certificates_one_active_uq')
      .on(t.nIde, t.year)
      .where(sql`${t.active} = true`),
  ],
);

export const holidayCalendars = pgTable(
  'holiday_calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    region: text('region').notNull().default('CO'),
    year: integer('year').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('BORRADOR'),
    source: text('source').notNull(),
    reason: text('reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid('published_by').references(() => accounts.id),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('holiday_calendars_version_uq').on(t.region, t.year, t.version),
    uniqueIndex('holiday_calendars_one_published_uq')
      .on(t.region, t.year)
      .where(sql`${t.status} = 'PUBLICADO'`),
  ],
);

export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => holidayCalendars.id),
    date: date('date').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('holidays_calendar_date_uq').on(t.calendarId, t.date)],
);

export const progVac = pgTable(
  'prog_vac',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nIde: text('n_ide').notNull(),
    nCont: text('n_cont').notNull(),
    perIni: date('per_ini').notNull(),
    perFin: date('per_fin').notNull(),
    dias: integer('dias').notNull(),
    disp: integer('disp').notNull(),
    /** EST del origen, sin interpretar hasta contar con su catálogo. */
    estOrigen: text('est_origen'),
    /** Estado interno: ACTIVA o LIQUIDADA (DISP = 0). */
    estado: text('estado').notNull().default('ACTIVA'),
    fechaCorte: date('fecha_corte'),
    version: integer('version').notNull().default(1),
    source: text('source').notNull().default('MANUAL'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => accounts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('prog_vac_period_uq')
      .on(t.nIde, t.nCont, t.perIni, t.perFin)
      .where(sql`${t.active} = true`),
    index('prog_vac_person_idx').on(t.nIde, t.nCont),
    check('prog_vac_range_ck', sql`${t.disp} >= 0 and ${t.disp} <= ${t.dias} and ${t.dias} <= 15`),
  ],
);

export const progVacAdjustments = pgTable(
  'prog_vac_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    progVacId: uuid('prog_vac_id')
      .notNull()
      .references(() => progVac.id),
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => accounts.id),
    version: integer('version').notNull(),
    oldDias: integer('old_dias').notNull(),
    newDias: integer('new_dias').notNull(),
    oldDisp: integer('old_disp').notNull(),
    newDisp: integer('new_disp').notNull(),
    reason: text('reason').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prog_vac_adjustments_idx').on(t.progVacId, t.at)],
);

export const vacationRequests = pgTable(
  'vacation_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    nIde: text('n_ide').notNull(),
    nCont: text('n_cont').notNull(),
    cEmp: text('c_emp').notNull(),
    cArea: text('c_area').notNull(),
    /** Jefe de área resuelto al enviar (vigente en esa fecha). */
    managerAccountId: uuid('manager_account_id')
      .notNull()
      .references(() => accounts.id),
    /** PENDIENTE_JEFE, REVISION_EMPLEADO, PENDIENTE_FINAL, APROBADA, RECHAZADA, CANCELADA */
    status: text('status').notNull().default('PENDIENTE_JEFE'),
    currentRevision: integer('current_revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vacation_requests_account_idx').on(t.accountId, t.createdAt),
    index('vacation_requests_manager_idx').on(t.managerAccountId, t.status),
    index('vacation_requests_status_idx').on(t.status),
  ],
);

export const vacationRevisions = pgTable(
  'vacation_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vacationRequests.id),
    number: integer('number').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** DIAS_DIS: diferencia literal en días calendario. */
    calendarDiff: integer('calendar_diff').notNull(),
    businessDays: integer('business_days').notNull(),
    returnDate: date('return_date').notNull(),
    countedDays: jsonb('counted_days').notNull(),
    calendarIds: jsonb('calendar_ids').notNull(),
    /** Quién creó la revisión (empleado o jefe) y por qué. */
    proposedBy: uuid('proposed_by')
      .notNull()
      .references(() => accounts.id),
    reason: text('reason'),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vacation_revisions_uq').on(t.requestId, t.number)],
);

export const vacationRevisionAllocations = pgTable(
  'vacation_revision_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => vacationRevisions.id),
    progVacId: uuid('prog_vac_id')
      .notNull()
      .references(() => progVac.id),
    days: integer('days').notNull(),
  },
  (t) => [
    uniqueIndex('vacation_alloc_uq').on(t.revisionId, t.progVacId),
    check('vacation_alloc_days_ck', sql`${t.days} > 0`),
  ],
);

export const vacationActions = pgTable(
  'vacation_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vacationRequests.id),
    revisionNumber: integer('revision_number').notNull(),
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => accounts.id),
    /** ENVIAR, ACEPTAR, PROPONER, APROBAR_JEFE, APROBAR_FINAL, RECHAZAR, CANCELAR */
    action: text('action').notNull(),
    comment: text('comment'),
    /** Hash del contenido de la revisión sobre la que se actuó. */
    contentHash: text('content_hash').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vacation_actions_request_idx').on(t.requestId, t.at)],
);

/** VACACIONES: disfrutes aprobados (SSD 6.2). */
export const vacaciones = pgTable(
  'vacaciones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vacationRequests.id),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => vacationRevisions.id),
    nIde: text('n_ide').notNull(),
    nCont: text('n_cont').notNull(),
    fecIniDis: date('fec_ini_dis').notNull(),
    fecFinDis: date('fec_fin_dis').notNull(),
    diasDis: integer('dias_dis').notNull(),
    diasHabiles: integer('dias_habiles').notNull(),
    fechaRetorno: date('fecha_retorno').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vacaciones_request_uq').on(t.requestId),
    index('vacaciones_person_idx').on(t.nIde, t.nCont, t.fecIniDis),
  ],
);

/** Configuración del servicio externo de festivos (una sola fila). La clave se guarda cifrada. */
export const holidayApiSettings = pgTable('holiday_api_settings', {
  id: integer('id').primaryKey().default(1),
  url: text('url').notNull(),
  apiKeyEnc: text('api_key_enc'),
  updatedBy: uuid('updated_by').references(() => accounts.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncYear: integer('last_sync_year'),
  lastSyncStatus: text('last_sync_status'),
});

/** Catálogo configurable de tipos de permiso (SSD 6.2). No consumen PROG_VAC.DISP. */
export const permitTypes = pgTable(
  'permit_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    supportRequired: boolean('support_required').notNull().default(false),
    /** Permite indicar horas cuando el permiso es de un solo día. */
    allowsHours: boolean('allows_hours').notNull().default(false),
    maxDays: integer('max_days'),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('permit_types_code_uq').on(t.code)],
);

export const permitRequests = pgTable(
  'permit_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    nIde: text('n_ide').notNull(),
    nCont: text('n_cont').notNull(),
    cEmp: text('c_emp').notNull(),
    cArea: text('c_area').notNull(),
    managerAccountId: uuid('manager_account_id')
      .notNull()
      .references(() => accounts.id),
    typeId: uuid('type_id')
      .notNull()
      .references(() => permitTypes.id),
    /** Copia de la regla vigente al enviar: cambiar el tipo después no altera solicitudes en curso. */
    typeName: text('type_name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    startTime: text('start_time'),
    endTime: text('end_time'),
    justification: text('justification').notNull(),
    /** Solo decide el jefe de área: PENDIENTE_JEFE, APROBADO, RECHAZADO, CANCELADO */
    status: text('status').notNull().default('PENDIENTE_JEFE'),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('permit_requests_account_idx').on(t.accountId, t.createdAt),
    index('permit_requests_manager_idx').on(t.managerAccountId, t.status),
    check('permit_requests_dates_ck', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export const permitSupports = pgTable(
  'permit_supports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => permitRequests.id),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('permit_supports_request_uq').on(t.requestId)],
);

export const permitActions = pgTable(
  'permit_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => permitRequests.id),
    actorAccountId: uuid('actor_account_id')
      .notNull()
      .references(() => accounts.id),
    /** ENVIAR, APROBAR, RECHAZAR, CANCELAR */
    action: text('action').notNull(),
    comment: text('comment'),
    contentHash: text('content_hash').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('permit_actions_request_idx').on(t.requestId, t.at)],
);

/** Configuración del correo saliente (una sola fila). Si no existe, se usan las variables SMTP_*. */
export const mailSettings = pgTable('mail_settings', {
  id: integer('id').primaryKey().default(1),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  /** SMTPS: TLS desde el inicio de la conexión (normalmente puerto 465). */
  secure: boolean('secure').notNull().default(false),
  /** Exigir STARTTLS: si el servidor no lo ofrece, no se envía. */
  requireTls: boolean('require_tls').notNull().default(true),
  username: text('username'),
  passwordEnc: text('password_enc'),
  /** Dirección de correo de origen (From). */
  fromEmail: text('from_email').notNull(),
  /** Nombre que acompaña a la dirección; opcional. */
  fromName: text('from_name'),
  updatedBy: uuid('updated_by').references(() => accounts.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastTestStatus: text('last_test_status'),
});

/** Retos del doble paso: un código de un solo uso enviado al correo (al ingresar o al activarlo). */
export const twoFactorChallenges = pgTable(
  'two_factor_challenges',
  {
    /** Identificador aleatorio que recibe el navegador entre la clave y el código. */
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    /** LOGIN: segundo paso del ingreso. ENABLE: confirmar que se controla el correo al activarlo. */
    purpose: text('purpose').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('two_factor_challenges_account_idx').on(t.accountId, t.purpose, t.createdAt)],
);

/** Constancia PDF de una solicitud de vacaciones aprobada, guardada como objeto (ADR-003). */
export const vacationDocuments = pgTable(
  'vacation_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => vacationRequests.id),
    /** Revisión aprobada a la que corresponde el documento. */
    revisionNumber: integer('revision_number').notNull(),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vacation_documents_request_uq').on(t.requestId)],
);
