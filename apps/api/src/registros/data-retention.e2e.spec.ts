import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  auditLogs,
  documentExportDownloads,
  documentExports,
  employeeSnapshots,
  importBatchRows,
  importBatches,
  roleAssignments,
  sessions,
  taxCertificates,
  verificationCodes,
} from '../db/schema';
import { EncryptedObjectStore } from '../storage/encrypted-object-store';
import { MemoryObjectStore } from '../storage/memory-object-store';
import { OBJECT_STORE } from '../storage/object-store';
import { DataRetentionService, validDataRetention } from './data-retention.service';
import { dataRetentionSettings } from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
const DAY = 86_400_000;
type Sess = { cookie: string; csrf: string; id: string };

describe('validación de la política', () => {
  it('exige días enteros dentro de un rango razonable', () => {
    const ok = {
      sessionsRetentionDays: 30,
      verificationCodesRetentionDays: 30,
      importStagingRetentionDays: 90,
      autoEnabled: false,
    };
    expect(validDataRetention(ok)).toBe(true);
    expect(validDataRetention({ ...ok, sessionsRetentionDays: 0 })).toBe(false);
    expect(validDataRetention({ ...ok, importStagingRetentionDays: 4000 })).toBe(false);
  });
});

describe.skipIf(!url)('retención de datos operativos (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  const raw = new MemoryObjectStore();
  const store = new EncryptedObjectStore(
    raw,
    'clave-de-objetos-de-prueba-con-mas-de-32-caracteres',
  );
  let app: INestApplication;
  let adm: Sess;
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OBJECT_STORE)
      .useValue(store)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE audit_logs, sessions, verification_codes, import_batch_rows, import_batches,
        document_export_downloads, document_exports, tax_certificates, data_retention_settings, role_assignments,
        accounts, employee_snapshots CASCADE`,
    );
    raw.objects.clear();
    await db
      .insert(employeeSnapshots)
      .values({ nIde: 'ADM', nCont: '1', email: 'adm@x.co', est: 'V', nombre: 'ADMIN' });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: 'ADM',
        email: 'adm@x.co',
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: accounts.id });
    await db
      .insert(roleAssignments)
      .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
    const res = await request(srv())
      .post('/auth/login')
      .send({ email: 'adm@x.co', password: PASSWORD })
      .expect(200);
    adm = {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
      id: a?.id ?? '',
    };
  });

  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: object) => {
    const agent = request(srv());
    const r = agent[method](path).set('Cookie', adm.cookie);
    if (method === 'get') return r;
    return r.set('X-CSRF-Token', adm.csrf).send(body ?? {});
  };

  it('la vista previa cuenta lo vencido sin borrar nada', async () => {
    const cutoffSessions = new Date(Date.now() - 31 * DAY);
    await db
      .insert(sessions)
      .values({ accountId: adm.id, tokenHash: 'viejo', expiresAt: cutoffSessions });
    const res = await call('get', '/admin/data-retention');
    expect(res.status).toBe(200);
    expect(res.body.preview.sessions).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(sessions);
    expect(rows.length).toBeGreaterThanOrEqual(1); // sigue ahí: la vista previa no borra
  });

  it('purga sesiones y códigos vencidos, filas de importación ya aplicadas y ZIP caducados', async () => {
    await db.insert(sessions).values({
      accountId: adm.id,
      tokenHash: 'sesion-vieja',
      expiresAt: new Date(Date.now() - 31 * DAY),
    });
    await db.insert(verificationCodes).values({
      accountId: adm.id,
      codeHash: 'codigo-viejo',
      expiresAt: new Date(Date.now() - 31 * DAY),
    });
    const [batch] = await db
      .insert(importBatches)
      .values({
        type: 'EMPLOYEES',
        status: 'APLICADO',
        fileHash: 'x'.repeat(10),
        sourceSystem: 'WEB',
        responsible: 'adm@x.co',
        createdBy: adm.id,
        appliedAt: new Date(Date.now() - 91 * DAY),
      })
      .returning({ id: importBatches.id });
    await db
      .insert(importBatchRows)
      .values({ batchId: batch?.id ?? '', rowNumber: 1, data: { salario: 1000 } });

    await store.put('exports/vencido.zip', Buffer.from('contenido'));
    await db.insert(documentExports).values({
      nIde: 'ADM',
      requestKind: 'MANUAL',
      status: 'LISTO',
      objectKey: 'exports/vencido.zip',
      sizeBytes: 9,
      expiresAt: new Date(Date.now() - DAY),
    });

    const res = await call('post', '/admin/data-retention/run');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: 1, verificationCodes: 1, importRows: 1, exports: 1 });

    expect(await db.select().from(sessions)).toHaveLength(1); // queda la sesión activa del admin
    expect(await db.select().from(verificationCodes)).toHaveLength(0);
    expect(await db.select().from(importBatchRows)).toHaveLength(0);
    expect(await db.select().from(importBatches)).toHaveLength(1); // la fila del lote se conserva
    expect(await db.select().from(documentExports)).toHaveLength(0);
    expect(await db.select().from(documentExportDownloads)).toHaveLength(0);
    expect(await store.get('exports/vencido.zip')).toBeNull();

    const logs = (await db.select().from(auditLogs)).map((l) => l.action);
    expect(logs).toContain('DATA_RETENTION_PURGE');
  });

  it('no toca sesiones ni códigos vigentes', async () => {
    await db.insert(sessions).values({
      accountId: adm.id,
      tokenHash: 'sesion-reciente',
      expiresAt: new Date(Date.now() + DAY),
    });
    await call('post', '/admin/data-retention/run');
    expect(await db.select().from(sessions)).toHaveLength(2); // la de la sesión activa del admin + esta
  });

  it('valida y guarda los plazos', async () => {
    const bad = await call('put', '/admin/data-retention/settings', {
      sessionsRetentionDays: 0,
      verificationCodesRetentionDays: 30,
      importStagingRetentionDays: 90,
      autoEnabled: false,
    });
    expect(bad.status).toBe(400);

    const ok = await call('put', '/admin/data-retention/settings', {
      sessionsRetentionDays: 7,
      verificationCodesRetentionDays: 7,
      importStagingRetentionDays: 30,
      autoEnabled: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.sessionsRetentionDays).toBe(7);
    expect(ok.body.autoEnabled).toBe(true);
  });

  async function seedCert(nIde: string, est: 'V' | 'C') {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email: `${nIde}@x.co`, est, nombre: nIde });
    await raw.put(`tax-certificates/${nIde}.pdf`, Buffer.from('pdf'), 'application/pdf');
    await db.insert(taxCertificates).values({
      nIde,
      year: 2025,
      version: 1,
      objectKey: `tax-certificates/${nIde}.pdf`,
      sha256: 'x',
      sizeBytes: 3,
      fileName: 'c.pdf',
    });
  }

  it('la purga automática nunca toca los certificados de retención', async () => {
    await seedCert('EXC', 'C');
    const r = await call('post', '/admin/data-retention/run');
    expect(r.status).toBe(200);
    expect(await db.select().from(taxCertificates)).toHaveLength(1);
    expect(raw.objects.has('tax-certificates/EXC.pdf')).toBe(true);
  });

  it('no permite borrar certificados de un empleado activo', async () => {
    await seedCert('ACT', 'V');
    const r = await call('delete', '/admin/data-retention/certificates/ACT', {
      confirmNIde: 'ACT',
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMPLOYEE_ACTIVE');
    expect(await db.select().from(taxCertificates)).toHaveLength(1);
  });

  it('exige confirmar el número de identificación', async () => {
    await seedCert('BAJ', 'C');
    const r = await call('delete', '/admin/data-retention/certificates/BAJ', {
      confirmNIde: 'otro',
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('NOT_CONFIRMED');
    expect(await db.select().from(taxCertificates)).toHaveLength(1);
  });

  it('borra a mano los certificados de un empleado dado de baja y audita', async () => {
    await seedCert('BAJ', 'C');
    const r = await call('delete', '/admin/data-retention/certificates/BAJ', {
      confirmNIde: 'BAJ',
    });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(1);
    expect(await db.select().from(taxCertificates)).toHaveLength(0);
    expect(raw.objects.has('tax-certificates/BAJ.pdf')).toBe(false);
    const logs = await db.select().from(auditLogs);
    expect(logs.some((l) => l.action === 'TAX_CERTIFICATES_DELETE')).toBe(true);
  });

  it('responde 404 si la persona no existe', async () => {
    const r = await call('delete', '/admin/data-retention/certificates/NADIE', {
      confirmNIde: 'NADIE',
    });
    expect(r.status).toBe(404);
  });

  describe('depuración automática y historial', () => {
    const oldSession = () =>
      db.insert(sessions).values({
        accountId: adm.id,
        tokenHash: `vieja-${Math.random()}`,
        expiresAt: new Date(Date.now() - 40 * DAY),
      });
    const svc = () => app.get(DataRetentionService);
    const staleSessions = async () =>
      (await db.select().from(sessions)).filter((r) => r.tokenHash.startsWith('vieja-')).length;

    it('desactivada: no depura nada', async () => {
      await oldSession();
      expect(await svc().runIfDue()).toBeNull();
      expect(await staleSessions()).toBe(1);
    });

    it('activada y vencida: depura, audita como automática y registra la aplicación', async () => {
      await oldSession();
      await db
        .insert(dataRetentionSettings)
        .values({ id: 1, autoEnabled: true })
        .onConflictDoUpdate({ target: dataRetentionSettings.id, set: { autoEnabled: true } });
      const r = await svc().runIfDue();
      expect(r).toMatchObject({ sessions: 1 });
      expect(await staleSessions()).toBe(0);

      const s = await svc().getSettings();
      expect(s.lastRunStatus).toBe('OK');
      expect(s.lastRunSummary).toContain('Sesiones 1');
      const logs = await db.select().from(auditLogs);
      const purge = logs.find((l) => l.action === 'DATA_RETENTION_PURGE');
      expect(purge?.actorAccountId).toBeNull();
      expect(purge?.context).toMatchObject({ automatic: true, sessions: 1 });
    });

    it('activada pero con una aplicación reciente: espera', async () => {
      await oldSession();
      await db
        .insert(dataRetentionSettings)
        .values({ id: 1, autoEnabled: true, lastRunAt: new Date(Date.now() - 2 * 3_600_000) })
        .onConflictDoUpdate({
          target: dataRetentionSettings.id,
          set: { autoEnabled: true, lastRunAt: new Date(Date.now() - 2 * 3_600_000) },
        });
      expect(await svc().runIfDue()).toBeNull();
      expect(await staleSessions()).toBe(1);
      // pasadas más de 20 horas, vuelve a correr
      expect(await svc().runIfDue(Date.now() + 19 * 3_600_000)).not.toBeNull();
    });

    it('el historial lista las depuraciones manuales y automáticas, la más reciente primero', async () => {
      await oldSession();
      await call('post', '/admin/data-retention/run').expect(200);
      await oldSession();
      await db
        .insert(dataRetentionSettings)
        .values({ id: 1, autoEnabled: true })
        .onConflictDoUpdate({
          target: dataRetentionSettings.id,
          set: { autoEnabled: true, lastRunAt: null },
        });
      await svc().runIfDue();
      const res = await call('get', '/admin/data-retention');
      expect(res.status).toBe(200);
      const h = res.body.history as { automatic: boolean; sessions: number }[];
      expect(h.map((x) => x.automatic)).toEqual([true, false]);
      expect(h.every((x) => x.sessions === 1)).toBe(true);
    });
  });
});
