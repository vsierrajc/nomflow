import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { png } from '../testing/png';
import { EncryptedObjectStore } from '../storage/encrypted-object-store';
import { MemoryObjectStore } from '../storage/memory-object-store';
import { OBJECT_STORE } from '../storage/object-store';
import { createDb } from '../db/client';
import { addDays, todayBogota } from './business-days';
import { runMigrations } from '../db/migrate';
import {
  auditLogs,
  accounts,
  areaManagerAssignments,
  companies,
  employeeSnapshots,
  holidayCalendars,
  holidays,
  progVac,
  progVacAdjustments,
  roleAssignments,
  shifts,
  vacaciones,
  vacationDocuments,
  vacationActions,
  vacationRequests,
  vacationRevisionAllocations,
  vacationRevisions,
} from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string; id: string };
type Role = (typeof roleAssignments.$inferInsert)['role'];

async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts =
    join(process.cwd(), '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: fonts,
    verbosity: 0,
  }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    text += content.items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  }
  return text.replace(/\s+/g, ' ');
}

describe.skipIf(!url)('solicitud de vacaciones: flujo completo (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  let emp: Sess;
  let mgr: Sess;
  let fin: Sess;
  let adm: Sess;
  let p1 = '';
  let p2 = '';
  const raw = new MemoryObjectStore();
  const store = new EncryptedObjectStore(
    raw,
    'clave-de-objetos-de-prueba-con-mas-de-32-caracteres',
  );

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

  async function login(email: string, id: string): Promise<Sess> {
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
      id,
    };
  }
  async function person(
    nIde: string,
    email: string,
    roles: { role: Role; area?: boolean; company?: string }[] = [],
    cArea = '10300',
  ): Promise<Sess> {
    await db.insert(employeeSnapshots).values({
      nIde,
      nCont: '1',
      email,
      est: 'V',
      nombre: `Persona ${nIde}`,
      cEmp: 'GA',
      cArea,
      turno: '01',
    });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
      })
      .returning({ id: accounts.id });
    for (const r of roles)
      await db.insert(roleAssignments).values({
        accountId: a?.id ?? '',
        role: r.role,
        validFrom: '2020-01-01',
        ...(r.area ? { companyCode: 'GA', areaCode: '10300' } : {}),
        ...(r.company ? { companyCode: r.company } : {}),
      });
    return login(email, a?.id ?? '');
  }
  const send = (s: Sess, method: 'post' | 'get', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'post' ? r.set('X-CSRF-Token', s.csrf).send(body ?? {}) : r;
  };
  async function calendar(year: number, days: string[], version = 1) {
    const [c] = await db
      .insert(holidayCalendars)
      .values({
        year,
        version,
        status: 'PUBLICADO',
        source: 'MANUAL',
        createdBy: adm.id,
        publishedBy: adm.id,
        publishedAt: new Date(),
      })
      .returning({ id: holidayCalendars.id });
    await db
      .insert(holidays)
      .values(days.map((d) => ({ calendarId: c?.id ?? '', date: d, name: 'Festivo' })));
    return c?.id ?? '';
  }
  const submit = (start: string, allocations: { progVacId: string; days: number }[], s = emp) =>
    send(s, 'post', '/me/vacations', { start, allocations });
  const status = async (id: string) =>
    (await db.select().from(vacationRequests).where(eq(vacationRequests.id, id)))[0]?.status;

  beforeEach(async () => {
    raw.objects.clear();
    raw.down = false;
    await db.execute(
      sql`TRUNCATE approver_signatures, vacation_documents, companies, vacaciones, vacation_actions, vacation_revision_allocations, vacation_revisions, vacation_requests, prog_vac_adjustments, prog_vac, holidays, holiday_calendars, area_manager_assignments, audit_logs, sessions, role_assignments, accounts, employee_snapshots, shifts CASCADE`,
    );
    await db.insert(shifts).values({
      code: '01',
      name: 'Turno 01',
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
    });
    adm = await person('ADM', 'adm@x.co', [{ role: 'HR_ADMIN' }], '99999');
    emp = await person('100', 'e@x.co');
    mgr = await person('200', 'm@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    fin = await person(
      '300',
      'f@x.co',
      [{ role: 'VACATION_FINAL_APPROVER', company: 'GA' }],
      '99999',
    );
    await db.insert(areaManagerAssignments).values({
      cEmp: 'GA',
      cArea: '10300',
      managerAccountId: mgr.id,
      validFrom: '2020-01-01',
      createdBy: adm.id,
    });
    await calendar(2026, ['2026-03-23']);
    await calendar(2027, ['2027-01-01']);
    const [a, b] = await db
      .insert(progVac)
      .values([
        { nIde: '100', nCont: '1', perIni: '2025-01-01', perFin: '2025-12-31', dias: 15, disp: 10 },
        { nIde: '100', nCont: '1', perIni: '2024-01-01', perFin: '2024-12-31', dias: 15, disp: 5 },
      ])
      .returning({ id: progVac.id });
    p1 = a?.id ?? '';
    p2 =
      (
        await db
          .select()
          .from(progVac)
          .where(sql`${progVac.perIni} = '2024-01-01'`)
      )[0]?.id ?? '';
    void b;
  });

  it('camino completo: envía, el jefe aprueba, el aprobador final descuenta y crea VACACIONES', async () => {
    const created = await submit('2026-03-02', [
      { progVacId: p1, days: 3 },
      { progVacId: p2, days: 2 },
    ]).expect(201);
    const id = created.body.id as string;
    expect(await status(id)).toBe('PENDIENTE_JEFE');
    // pendiente: no consume días
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(10);

    const mine = await send(emp, 'get', '/me/vacations').expect(200);
    expect(mine.body[0]).toMatchObject({
      id,
      status: 'PENDIENTE_JEFE',
      start: '2026-03-02',
      end: '2026-03-06',
      calendarDiff: 4,
      businessDays: 5,
      returnDate: '2026-03-09',
    });
    const inbox = await send(mgr, 'get', '/approvals/vacations/manager').expect(200);
    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0].employee).toBe('Persona 100');

    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(409); // aún sin jefe
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(200);
    expect(await status(id)).toBe('PENDIENTE_FINAL');
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(200);
    expect(await status(id)).toBe('APROBADA');

    const periods = await db.select().from(progVac);
    expect(Object.fromEntries(periods.map((p) => [p.id, [p.disp, p.estado]]))).toEqual({
      [p1]: [7, 'ACTIVA'],
      [p2]: [3, 'ACTIVA'],
    });
    const [v] = await db.select().from(vacaciones);
    expect(v).toMatchObject({
      nIde: '100',
      nCont: '1',
      fecIniDis: '2026-03-02',
      fecFinDis: '2026-03-06',
      diasDis: 4,
      diasHabiles: 5,
      fechaRetorno: '2026-03-09',
    });
    expect(await db.select().from(progVacAdjustments)).toHaveLength(2);
    const acts = await db.select().from(vacationActions).orderBy(vacationActions.at);
    expect(acts.map((a) => a.action)).toEqual(['ENVIAR', 'APROBAR_JEFE', 'APROBAR_FINAL']);
    expect(new Set(acts.map((a) => a.contentHash)).size).toBe(1);
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(409); // ya aprobada
    const det = await send(emp, 'get', `/me/vacations/${id}`).expect(200);
    expect(det.body.revisions[0].allocations).toHaveLength(2);
  });

  it('solo se puede pedir de los períodos de PROG_VAC con días disponibles del propio contrato', async () => {
    const periods = async () =>
      (await send(emp, 'get', '/me/vacations/periods').expect(200)).body as { id: string }[];
    expect((await periods()).map((p) => p.id).sort()).toEqual([p1, p2].sort());

    // liquidado (DISP = 0): no se ofrece ni se acepta
    const [liq] = await db
      .insert(progVac)
      .values({
        nIde: '100',
        nCont: '1',
        perIni: '2023-01-01',
        perFin: '2023-12-31',
        dias: 15,
        disp: 0,
        estado: 'LIQUIDADA',
      })
      .returning({ id: progVac.id });
    // dado de baja
    const [off] = await db
      .insert(progVac)
      .values({
        nIde: '100',
        nCont: '1',
        perIni: '2022-01-01',
        perFin: '2022-12-31',
        dias: 15,
        disp: 5,
        active: false,
      })
      .returning({ id: progVac.id });
    // de otro contrato de la misma persona y de otra persona
    const [oc] = await db
      .insert(progVac)
      .values({
        nIde: '100',
        nCont: '2',
        perIni: '2021-01-01',
        perFin: '2021-12-31',
        dias: 15,
        disp: 5,
      })
      .returning({ id: progVac.id });
    await person('700', 'x7@x.co');
    const [ot] = await db
      .insert(progVac)
      .values({
        nIde: '700',
        nCont: '1',
        perIni: '2025-01-01',
        perFin: '2025-12-31',
        dias: 15,
        disp: 15,
      })
      .returning({ id: progVac.id });
    expect((await periods()).map((p) => p.id).sort()).toEqual([p1, p2].sort());

    const body = (id: string) => ({
      start: '2026-03-02',
      allocations: [{ progVacId: id, days: 1 }],
    });
    for (const path of ['/me/vacations/preview', '/me/vacations']) {
      const codes: [string, number, string?][] = [
        [liq?.id ?? '', 400, 'PERIOD_NOT_AVAILABLE'],
        [off?.id ?? '', 404],
        [oc?.id ?? '', 404],
        [ot?.id ?? '', 404],
        ['00000000-0000-4000-8000-000000000000', 404],
      ];
      for (const [id, status, code] of codes) {
        const res = await send(emp, 'post', path, body(id)).expect(status);
        if (code) expect(res.body.code, `${path} ${id}`).toBe(code);
      }
    }
    // mezclar un período válido con uno no disponible tampoco pasa
    await send(emp, 'post', '/me/vacations', {
      start: '2026-03-02',
      allocations: [
        { progVacId: p1, days: 1 },
        { progVacId: liq?.id ?? '', days: 1 },
      ],
    }).expect(400);
    expect(await db.select().from(vacationRequests)).toHaveLength(0);

    // el jefe tampoco puede proponer períodos no disponibles
    const ok = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${ok.body.id}/propose`, {
      start: '2026-03-02',
      allocations: [{ progVacId: liq?.id ?? '', days: 1 }],
      reason: 'Se prueba con un período liquidado',
    }).expect(400);
    await send(mgr, 'post', `/approvals/vacations/manager/${ok.body.id}/propose`, {
      start: '2026-03-02',
      allocations: [{ progVacId: ot?.id ?? '', days: 1 }],
      reason: 'Se prueba con un período ajeno',
    }).expect(404);
    expect(await status(ok.body.id)).toBe('PENDIENTE_JEFE');
  });

  it('validaciones al enviar: remanente, jefe, cruce de fechas y calendario', async () => {
    await submit('2026-03-02', [{ progVacId: p2, days: 6 }]).expect(400); // > DISP
    await submit('2026-03-07', [{ progVacId: p1, days: 1 }]).expect(400); // sábado
    await submit('2026-03-02', [
      { progVacId: p1, days: 1 },
      { progVacId: p1, days: 1 },
    ]).expect(400);
    await submit('2028-03-02', [{ progVacId: p1, days: 1 }]).expect(422); // sin calendario
    const ok = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    await submit('2026-03-04', [{ progVacId: p2, days: 2 }]).expect(409); // se cruza
    await submit('2026-03-09', [{ progVacId: p2, days: 2 }]).expect(201);
    await send(emp, 'post', `/me/vacations/${ok.body.id}/cancel`).expect(200);
    expect(await status(ok.body.id)).toBe('CANCELADA');
    await send(emp, 'post', `/me/vacations/${ok.body.id}/cancel`).expect(409);
    const other = await person('500', 'o@x.co', [], '10300');
    await submit('2026-03-02', [{ progVacId: p1, days: 1 }], other).expect(404); // período ajeno

    await db.delete(areaManagerAssignments);
    await submit('2026-06-01', [{ progVacId: p1, days: 1 }]).expect(422); // sin jefe vigente
  });

  it('sin turno asignado, o con un turno que no existe en el catálogo, se bloquea con SHIFT_MISSING', async () => {
    await db
      .update(employeeSnapshots)
      .set({ turno: null })
      .where(eq(employeeSnapshots.nIde, '100'));
    const noShift = await submit('2026-03-02', [{ progVacId: p1, days: 1 }]).expect(422);
    expect(noShift.body.code).toBe('SHIFT_MISSING');

    await db
      .update(employeeSnapshots)
      .set({ turno: 'NO_EXISTE' })
      .where(eq(employeeSnapshots.nIde, '100'));
    const unknownShift = await submit('2026-03-02', [{ progVacId: p1, days: 1 }]).expect(422);
    expect(unknownShift.body.code).toBe('SHIFT_MISSING');
  });

  it('un turno con sábado laboral permite incluir el sábado en el disfrute', async () => {
    await db.insert(shifts).values({
      code: '02',
      name: 'Turno 02',
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: true,
    });
    await db
      .update(employeeSnapshots)
      .set({ turno: '02' })
      .where(eq(employeeSnapshots.nIde, '100'));
    // 2026-03-02 es lunes; con turno 02, 6 días hábiles alcanzan el sábado 2026-03-07.
    await submit('2026-03-02', [
      { progVacId: p1, days: 5 },
      { progVacId: p2, days: 1 },
    ]).expect(201);
    const mine = await send(emp, 'get', '/me/vacations').expect(200);
    expect(mine.body[0]).toMatchObject({ end: '2026-03-07', returnDate: '2026-03-09' });
  });

  it('el jefe rechaza con motivo o propone cambios que el empleado debe aceptar', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/reject`, {
      reason: 'corto',
    }).expect(400);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/reject`, {
      reason: 'Hay cierre contable esa semana',
    }).expect(200);
    expect(await status(a.body.id)).toBe('RECHAZADA');
    expect(await db.select().from(vacaciones)).toHaveLength(0);

    const b = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    const id = b.body.id as string;
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/propose`, {
      start: '2026-03-30',
      allocations: [{ progVacId: p1, days: 3 }],
      reason: 'x',
    }).expect(400);
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/propose`, {
      start: '2026-03-30',
      allocations: [{ progVacId: p1, days: 3 }],
      reason: 'Se reprograma por cierre de mes',
    }).expect(200);
    expect(await status(id)).toBe('REVISION_EMPLEADO');
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(409); // falta aceptación
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(409);
    await send(mgr, 'post', `/me/vacations/${id}/accept`).expect(404); // no es el dueño
    await send(emp, 'post', `/me/vacations/${id}/accept`).expect(200);
    expect(await status(id)).toBe('PENDIENTE_FINAL');
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(200);
    const [v] = await db.select().from(vacaciones);
    expect(v).toMatchObject({
      fecIniDis: '2026-03-30',
      fecFinDis: '2026-04-01',
      diasHabiles: 3,
      diasDis: 2,
      fechaRetorno: '2026-04-02',
    });
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(7);
    const det = await send(emp, 'get', `/me/vacations/${id}`).expect(200);
    expect(det.body.revisions).toHaveLength(2);
    expect(det.body.revisions[1].reason).toBe('Se reprograma por cierre de mes');
  });

  it('si el jefe propone cambios, la constancia lleva igualmente su firma (y la de la aprobación final)', async () => {
    const b = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    const id = b.body.id as string;
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/propose`, {
      start: '2026-03-30',
      allocations: [{ progVacId: p1, days: 3 }],
      reason: 'Se reprograma por cierre de mes',
    }).expect(200);
    await send(emp, 'post', `/me/vacations/${id}/accept`).expect(200);
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(200);

    // la propuesta es el acto autenticado del jefe sobre la revisión aprobada: no hay otro «aprobar»
    const actions = (
      await db.select().from(vacationActions).where(eq(vacationActions.requestId, id))
    )
      .sort((a, c) => a.at.getTime() - c.at.getTime())
      .map((a) => `${a.action}@${a.revisionNumber}`);
    expect(actions).toEqual(['ENVIAR@1', 'PROPONER@2', 'ACEPTAR@2', 'APROBAR_FINAL@2']);

    const text = await pdfText(body(await binary(pdf(emp, id)).expect(200)));
    expect(text).toContain('Jefe de área');
    expect(text).toContain('Aprobación final');
    expect(text.match(/Firma en imagen no registrada/g)).toHaveLength(2);
  });

  it('si el área cambió de jefe, Gestión Humana reasigna la solicitud pendiente al aprobador vigente', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    const id = a.body.id as string;
    const pending = async () =>
      (await send(adm, 'get', '/admin/vacations/pending-approval').expect(200)).body;

    // sin cambios la tiene quien corresponde, y no hay nada que reasignar
    expect(await pending()).toMatchObject([
      { id, state: 'VIGENTE', assignedTo: 'Persona 200', currentApprover: 'Persona 200' },
    ]);
    const same = await send(adm, 'post', `/admin/vacations/${id}/reassign`).expect(409);
    expect(same.body.code).toBe('ALREADY_CURRENT');

    // el área cambia de jefe: el anterior termina su cargo y entra otra persona
    const mgr2 = await person('250', 'm2@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    await db
      .update(roleAssignments)
      .set({ validTo: '2020-06-30' })
      .where(eq(roleAssignments.accountId, mgr.id));
    await db
      .update(areaManagerAssignments)
      .set({ validTo: '2020-06-30' })
      .where(eq(areaManagerAssignments.managerAccountId, mgr.id));
    await db.insert(areaManagerAssignments).values({
      cEmp: 'GA',
      cArea: '10300',
      managerAccountId: mgr2.id,
      validFrom: '2020-07-01',
      createdBy: adm.id,
    });
    // la solicitud quedó atada al anterior: él ya no puede decidirla y el nuevo no la ve
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(403);
    expect((await send(mgr2, 'get', '/approvals/vacations/manager').expect(200)).body).toHaveLength(
      0,
    );
    await send(mgr2, 'post', `/approvals/vacations/manager/${id}/approve`).expect(404);
    expect(await pending()).toMatchObject([
      { id, state: 'REASIGNABLE', assignedTo: 'Persona 200', currentApprover: 'Persona 250' },
    ]);

    // solo Gestión Humana reasigna
    await send(emp, 'post', `/admin/vacations/${id}/reassign`).expect(403);
    await send(
      adm,
      'post',
      '/admin/vacations/00000000-0000-4000-8000-000000000000/reassign',
    ).expect(404);
    await send(adm, 'post', `/admin/vacations/${id}/reassign`).expect(204);

    expect(await pending()).toMatchObject([{ id, state: 'VIGENTE', assignedTo: 'Persona 250' }]);
    expect((await send(mgr2, 'get', '/approvals/vacations/manager').expect(200)).body).toHaveLength(
      1,
    );
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(403); // sin el rol
    await send(mgr2, 'post', `/approvals/vacations/manager/${id}/approve`).expect(200);
    expect(await status(id)).toBe('PENDIENTE_FINAL');

    const actions = (
      await db.select().from(vacationActions).where(eq(vacationActions.requestId, id))
    )
      .sort((x, y) => x.at.getTime() - y.at.getTime())
      .map((x) => x.action);
    expect(actions).toEqual(['ENVIAR', 'REASIGNAR', 'APROBAR_JEFE']);
    expect((await db.select().from(auditLogs)).map((l) => l.action)).toContain(
      'VACATION_REASIGNAR',
    );

    // ya no está pendiente del jefe: no hay nada que reasignar
    expect(await pending()).toEqual([]);
    const late = await send(adm, 'post', `/admin/vacations/${id}/reassign`).expect(409);
    expect(late.body.code).toBe('INVALID_STATE');
  });

  it('si el área no tiene un único aprobador vigente, se avisa y no se puede reasignar', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    const id = a.body.id as string;
    await db.delete(areaManagerAssignments);
    const list = (await send(adm, 'get', '/admin/vacations/pending-approval').expect(200)).body;
    expect(list).toMatchObject([{ id, state: 'SIN_APROBADOR', currentApprover: null }]);
    const res = await send(adm, 'post', `/admin/vacations/${id}/reassign`).expect(422);
    expect(res.body.code).toBe('NO_MANAGER');
    expect(await status(id)).toBe('PENDIENTE_JEFE');
  });

  it('si el empleado ya salió (EST = C), no se aprueba su solicitud ni se descuentan días; sí se puede rechazar', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    const b = await submit('2026-06-01', [{ progVacId: p1, days: 1 }]).expect(201);
    const [idA, idB] = [a.body.id as string, b.body.id as string];
    await send(mgr, 'post', `/approvals/vacations/manager/${idA}/approve`).expect(200);
    expect(await status(idA)).toBe('PENDIENTE_FINAL');

    await db.update(employeeSnapshots).set({ est: 'C' }).where(eq(employeeSnapshots.nIde, '100'));

    // ni el jefe ni la aprobación final conceden algo a quien ya no tiene contrato vigente
    const finRes = await send(fin, 'post', `/approvals/vacations/final/${idA}/approve`).expect(422);
    expect(finRes.body.code).toBe('NO_ACTIVE_CONTRACT');
    const mgrRes = await send(mgr, 'post', `/approvals/vacations/manager/${idB}/approve`).expect(
      422,
    );
    expect(mgrRes.body.code).toBe('NO_ACTIVE_CONTRACT');
    expect(await status(idA)).toBe('PENDIENTE_FINAL');
    expect(await status(idB)).toBe('PENDIENTE_JEFE');
    expect(await db.select().from(vacaciones)).toHaveLength(0);
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(10);

    // la salida es rechazarlas, con motivo
    await send(fin, 'post', `/approvals/vacations/final/${idA}/reject`, {
      reason: 'La persona ya no tiene contrato vigente',
    }).expect(200);
    await send(mgr, 'post', `/approvals/vacations/manager/${idB}/reject`, {
      reason: 'La persona ya no tiene contrato vigente',
    }).expect(200);
    expect(await status(idA)).toBe('RECHAZADA');
    expect(await status(idB)).toBe('RECHAZADA');
  });

  it('una solicitud nueva o una propuesta no pueden empezar antes de hoy (hora de Colombia)', async () => {
    const previous = process.env.VACATION_ALLOW_PAST_START;
    delete process.env.VACATION_ALLOW_PAST_START;
    try {
      const yesterday = addDays(todayBogota(), -1);
      const body = { start: yesterday, allocations: [{ progVacId: p1, days: 2 }] };
      for (const path of ['/me/vacations/preview', '/me/vacations']) {
        const res = await send(emp, 'post', path, body).expect(400);
        expect(res.body.code).toBe('START_IN_PAST');
      }
      expect(await db.select().from(vacationRequests)).toHaveLength(0);

      // hoy sí pasa esta regla (otra regla, como el día hábil o el calendario, puede rechazarla)
      const today = await send(emp, 'post', '/me/vacations/preview', {
        ...body,
        start: todayBogota(),
      });
      expect(today.body.code).not.toBe('START_IN_PAST');

      // el jefe tampoco puede proponer una fecha pasada
      process.env.VACATION_ALLOW_PAST_START = 'true';
      const ok = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
      delete process.env.VACATION_ALLOW_PAST_START;
      const res = await send(mgr, 'post', `/approvals/vacations/manager/${ok.body.id}/propose`, {
        ...body,
        reason: 'Se reprograma por cierre de mes',
      }).expect(400);
      expect(res.body.code).toBe('START_IN_PAST');
      expect(await status(ok.body.id as string)).toBe('PENDIENTE_JEFE');
    } finally {
      if (previous === undefined) delete process.env.VACATION_ALLOW_PAST_START;
      else process.env.VACATION_ALLOW_PAST_START = previous;
    }
  });

  it('solo quien tiene el rol y la asignación puede aprobar; nadie firma su propia solicitud', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    const id = a.body.id as string;
    // administrador sin el rol específico
    await send(adm, 'get', '/approvals/vacations/manager').expect(403);
    await send(adm, 'post', `/approvals/vacations/final/${id}/approve`).expect(403);
    // empleado
    await send(emp, 'post', `/approvals/vacations/manager/${id}/approve`).expect(403);
    // otro jefe con el rol, pero sin la asignación
    const other = await person('600', 'o2@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    await send(other, 'post', `/approvals/vacations/manager/${id}/approve`).expect(404);
    // un tercero no ve el detalle
    await send(other, 'get', `/me/vacations/${id}`).expect(404);
    await send(emp, 'get', `/me/vacations/${id}`).expect(200);
    await send(mgr, 'get', `/me/vacations/${id}`).expect(200);
    // sin sesión
    await request(srv()).get('/me/vacations').expect(401);
    await request(srv()).post(`/approvals/vacations/final/${id}/approve`).expect(401);

    // el jefe pide sus propias vacaciones: no las aprueba él; sin director del área no hay quién decida
    const [pm] = await db
      .insert(progVac)
      .values({
        nIde: '200',
        nCont: '1',
        perIni: '2025-01-01',
        perFin: '2025-12-31',
        dias: 15,
        disp: 15,
      })
      .returning({ id: progVac.id });
    await submit('2026-05-04', [{ progVacId: pm?.id ?? '', days: 2 }], mgr).expect(422);
  });

  it('aprobación jerárquica: jefe → director → gerente general, y el gerente general se autoaprueba', async () => {
    const dir = await person('700', 'd@x.co', [{ role: 'AREA_DIRECTOR', area: true }]);
    const gm = await person('800', 'g@x.co', [{ role: 'GENERAL_MANAGER', company: 'GA' }], '99999');
    const pv = async (nIde: string) =>
      (
        await db
          .insert(progVac)
          .values({
            nIde,
            nCont: '1',
            perIni: '2025-01-01',
            perFin: '2025-12-31',
            dias: 15,
            disp: 15,
          })
          .returning({ id: progVac.id })
      )[0]?.id ?? '';
    const first = async (id: string) =>
      (await db.select().from(vacationRequests).where(eq(vacationRequests.id, id)))[0];

    // empleado → jefe de área
    const e = await submit('2026-03-02', [{ progVacId: p1, days: 1 }]).expect(201);
    expect((await first(e.body.id))?.managerAccountId).toBe(mgr.id);
    expect((await first(e.body.id))?.firstApproverRole).toBe('AREA_MANAGER');

    // jefe → director del área: el director la ve y la aprueba; el jefe no puede
    const m = await submit('2026-05-04', [{ progVacId: await pv('200'), days: 2 }], mgr).expect(
      201,
    );
    expect((await first(m.body.id))?.managerAccountId).toBe(dir.id);
    expect((await first(m.body.id))?.firstApproverRole).toBe('AREA_DIRECTOR');
    await send(mgr, 'post', `/approvals/vacations/manager/${m.body.id}/approve`).expect(404);
    const inbox = await send(dir, 'get', '/approvals/vacations/manager').expect(200);
    expect(inbox.body).toHaveLength(1);
    await send(dir, 'post', `/approvals/vacations/manager/${m.body.id}/approve`).expect(200);
    expect(await status(m.body.id)).toBe('PENDIENTE_FINAL');
    await send(fin, 'post', `/approvals/vacations/final/${m.body.id}/approve`).expect(200);
    // la constancia rotula la firma con el cargo con que se aprobó: aquí el director de área
    expect(await pdfText(body(await binary(pdf(mgr, m.body.id)).expect(200)))).toContain(
      'Director de área',
    );

    // director → gerente general
    const d = await submit('2026-06-01', [{ progVacId: await pv('700'), days: 2 }], dir).expect(
      201,
    );
    expect((await first(d.body.id))?.managerAccountId).toBe(gm.id);
    expect((await first(d.body.id))?.firstApproverRole).toBe('GENERAL_MANAGER');
    await send(dir, 'post', `/approvals/vacations/manager/${d.body.id}/approve`).expect(404);
    await send(gm, 'post', `/approvals/vacations/manager/${d.body.id}/approve`).expect(200);
    expect(await status(d.body.id)).toBe('PENDIENTE_FINAL');

    // gerente general: su propia aprobación queda registrada y pasa a la aprobación final
    const g = await submit('2026-07-06', [{ progVacId: await pv('800'), days: 2 }], gm).expect(201);
    expect(await status(g.body.id)).toBe('PENDIENTE_FINAL');
    const acts = await db
      .select()
      .from(vacationActions)
      .where(eq(vacationActions.requestId, g.body.id))
      .orderBy(vacationActions.at);
    expect(acts.map((a) => a.action)).toEqual(['ENVIAR', 'APROBAR_JEFE']);
    expect(acts[1]?.comment).toContain('Autoaprobación del gerente general');
    await send(fin, 'post', `/approvals/vacations/final/${g.body.id}/approve`).expect(200);
    expect(await status(g.body.id)).toBe('APROBADA');
  });

  it('el aprobador final es por empresa: solo ve y firma las solicitudes de sus empresas', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    const id = a.body.id as string;
    await send(mgr, 'post', `/approvals/vacations/manager/${id}/approve`).expect(200);

    // aprobador de otra empresa (GB): con el rol, pero ajeno a esta solicitud
    const otherCo = await person(
      '810',
      'gb@x.co',
      [{ role: 'VACATION_FINAL_APPROVER', company: 'GB' }],
      '99999',
    );
    expect((await send(otherCo, 'get', '/approvals/vacations/final').expect(200)).body).toEqual([]);
    await send(otherCo, 'get', `/me/vacations/${id}`).expect(404);
    await send(otherCo, 'post', `/approvals/vacations/final/${id}/approve`).expect(404);
    await send(otherCo, 'post', `/approvals/vacations/final/${id}/reject`, {
      reason: 'No le corresponde a esta empresa',
    }).expect(404);

    // rol sin empresa (asignación antigua): no da acceso a nada
    const noCo = await person('820', 'nc@x.co', [{ role: 'VACATION_FINAL_APPROVER' }], '99999');
    expect((await send(noCo, 'get', '/approvals/vacations/final').expect(200)).body).toEqual([]);
    await send(noCo, 'post', `/approvals/vacations/final/${id}/approve`).expect(403);
    expect(await status(id)).toBe('PENDIENTE_FINAL');

    // el de la empresa GA sí la ve y la firma
    const list = await send(fin, 'get', '/approvals/vacations/final').expect(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([id]);
    await send(fin, 'post', `/approvals/vacations/final/${id}/approve`).expect(200);
    expect(await status(id)).toBe('APROBADA');
  });

  it('asignar el rol de aprobador final exige una empresa registrada', async () => {
    await db
      .insert(companies)
      .values({ cEmp: 'GA', nombre: 'Empresa GA', sigla: 'GA', direccion: 'CL 1 2 3' });
    const target = await person('830', 't@x.co', [], '99999');
    void target;
    const [t] = await db.select().from(accounts).where(eq(accounts.nIde, '830'));
    const grant = (body: object) =>
      send(adm, 'post', `/admin/accounts/${t?.id}/roles`, { validFrom: '2026-01-01', ...body });
    await grant({ role: 'VACATION_FINAL_APPROVER' }).expect(422); // sin empresa
    await grant({ role: 'VACATION_FINAL_APPROVER', cEmp: 'ZZ' }).expect(404); // empresa inexistente
    await grant({ role: 'VACATION_FINAL_APPROVER', cEmp: 'GA' }).expect(201);
  });

  /** Solicitud aprobada de punta a punta; devuelve su id. */
  async function approved(start = '2026-03-02', days = 5) {
    const a = await submit(start, [{ progVacId: p1, days }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(200);
    await send(fin, 'post', `/approvals/vacations/final/${a.body.id}/approve`).expect(200);
    return a.body.id as string;
  }
  const pdf = (s: Sess, id: string) =>
    request(srv()).get(`/me/vacations/${id}/pdf`).set('Cookie', s.cookie);
  const body = (r: request.Response) => r.body as Buffer;
  const binary = (r: request.Test) =>
    r.buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });

  it('al aprobar, la constancia PDF queda guardada como objeto cifrado y con su huella', async () => {
    const id = await approved();
    const [doc] = await db.select().from(vacationDocuments);
    expect(doc).toMatchObject({
      requestId: id,
      revisionNumber: 1,
      objectKey: `vacation-requests/${id}/rev-1.pdf`,
    });
    expect(doc?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...raw.objects.keys()]).toEqual([doc?.objectKey]);
    expect(
      raw.objects
        .get(doc?.objectKey ?? '')
        ?.data.subarray(0, 3)
        .toString(),
    ).toBe('NF1'); // cifrado
    expect(raw.objects.get(doc?.objectKey ?? '')?.contentType).toBe('application/pdf');

    const res = await binary(pdf(emp, id)).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const text = await pdfText(body(res));
    expect(text).toContain('CONSTANCIA DE SOLICITUD DE VACACIONES APROBADA');
    expect(text).toContain('Persona 100'); // el empleado
    expect(text).toContain('2 de marzo de 2026'); // inicio
    expect(text).toContain('6 de marzo de 2026'); // último día hábil
    expect(text).toContain('9 de marzo de 2026'); // retorno
    expect(text).toMatch(/Días hábiles aprobados \(se descuentan\) 5/);
    expect(text).toMatch(/Diferencia en días calendario \(fin - inicio\) 4/);
    expect(text).toContain('Solicitud enviada y fechas aceptadas por el empleado');
    expect(text).toContain('Aprobada por el jefe de área');
    expect(text).toContain('Persona 200'); // el jefe
    expect(text).toContain('Aprobación final');
    expect(text).toContain('Persona 300'); // el aprobador final
    expect(text).toContain('no equivalen a una firma digital');
  });

  describe('anular un disfrute aprobado', () => {
    const annul = (s: Sess, id: string, reason = 'Se aprobó con las fechas equivocadas') =>
      send(s, 'post', `/admin/vacations/${id}/annul`, { reason });
    const disp = async (id: string) =>
      (await db.select().from(progVac).where(eq(progVac.id, id)))[0]?.disp;
    const future = () => new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const past = () => new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    /** El disfrute del escenario es de marzo de 2026: se lo lleva al futuro, sin ningún día ya disfrutado. */
    const notStarted = async () => {
      for (const v of await db.select().from(vacaciones)) {
        await db
          .update(vacaciones)
          .set({ fecIniDis: future(), fecFinDis: addDays(future(), v.diasHabiles) })
          .where(eq(vacaciones.id, v.id));
        await db
          .update(vacationRevisions)
          .set({
            countedDays: Array.from({ length: v.diasHabiles }, (_, i) => addDays(future(), i)),
          })
          .where(eq(vacationRevisions.id, v.revisionId));
      }
    };

    it('devuelve los días, anula la constancia y deja volver a solicitar', async () => {
      const id = await approved('2026-03-02', 5);
      expect(await disp(p1)).toBe(5); // 10 - 5
      await pdf(emp, id).expect(200);
      // el disfrute del escenario es de marzo de 2026: se lo lleva a una fecha que aún no termina
      await notStarted();

      // solo Gestión Humana, con motivo, y solo lo aprobado
      await annul(emp, id).expect(403);
      await annul(mgr, id).expect(403);
      await annul(adm, id, 'corto').expect(400);
      const pending = await submit('2026-04-06', [{ progVacId: p1, days: 1 }]).expect(201);
      await annul(adm, pending.body.id).expect(409); // NOT_APPROVED
      await annul(adm, '00000000-0000-4000-8000-000000000000').expect(404);

      const list = (await send(adm, 'get', '/admin/vacations/approved').expect(200)).body;
      expect(list.items.find((r: { id: string }) => r.id === id)).toMatchObject({
        employee: 'Persona 100',
        status: 'APROBADA',
        businessDays: 5,
        canAnnul: true,
        allocations: [{ days: 5 }],
      });

      await annul(adm, id).expect(204);
      expect(await disp(p1)).toBe(10); // devueltos
      expect(await status(id)).toBe('ANULADA');
      const [vac] = await db.select().from(vacaciones).where(eq(vacaciones.requestId, id));
      expect(vac?.annulledAt).not.toBeNull();
      expect(vac?.annulReason).toContain('fechas equivocadas');
      const adj = await db.select().from(progVacAdjustments);
      expect(adj.some((a) => a.reason.startsWith('Disfrute anulado') && a.newDisp === 10)).toBe(
        true,
      );
      expect((await db.select().from(vacationActions)).map((a) => a.action)).toContain('ANULAR');

      // la constancia ya no se entrega; no se anula dos veces; el filtro por estado funciona
      const res = await pdf(emp, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ANNULLED');
      await annul(adm, id).expect(409);
      const count = async (qs: string) =>
        (await send(adm, 'get', `/admin/vacations/approved?${qs}`).expect(200)).body.total;
      expect(await count('status=ANULADA')).toBe(1);
      expect(await count('status=APROBADA')).toBe(0);
      expect(await count('q=Persona')).toBe(1);
      await send(adm, 'get', '/admin/vacations/approved?status=X').expect(400);

      // el empleado puede pedir de nuevo las mismas fechas
      await send(emp, 'post', `/me/vacations/${pending.body.id}/cancel`).expect(200);
      await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
      expect((await db.select().from(auditLogs)).map((l) => l.action)).toContain('VACATION_ANULAR');
    });

    /**
     * Un disfrute en curso: 5 días hábiles contados de anteayer a pasado mañana (hoy en medio), cargados 3 al período
     * más antiguo (p2) y 2 al más reciente (p1). Se siembra directo para no depender del día de la semana.
     */
    async function inProgress(counted: string[], lastDay: string) {
      const today = todayBogota();
      await db.update(progVac).set({ disp: 2 }).where(eq(progVac.id, p2)); // 5 - 3
      await db.update(progVac).set({ disp: 8 }).where(eq(progVac.id, p1)); // 10 - 2
      const [req] = await db
        .insert(vacationRequests)
        .values({
          accountId: emp.id,
          nIde: '100',
          nCont: '1',
          cEmp: 'GA',
          cArea: '10300',
          managerAccountId: mgr.id,
          status: 'APROBADA',
        })
        .returning({ id: vacationRequests.id });
      const [rev] = await db
        .insert(vacationRevisions)
        .values({
          requestId: req?.id ?? '',
          number: 1,
          startDate: counted[0] ?? today,
          endDate: lastDay,
          calendarDiff: 4,
          businessDays: 5,
          returnDate: addDays(lastDay, 1),
          countedDays: counted,
          calendarIds: [],
          proposedBy: emp.id,
          contentHash: 'h',
        })
        .returning({ id: vacationRevisions.id });
      await db.insert(vacationRevisionAllocations).values([
        { revisionId: rev?.id ?? '', progVacId: p2, days: 3 },
        { revisionId: rev?.id ?? '', progVacId: p1, days: 2 },
      ]);
      await db.insert(vacaciones).values({
        requestId: req?.id ?? '',
        revisionId: rev?.id ?? '',
        nIde: '100',
        nCont: '1',
        fecIniDis: counted[0] ?? today,
        fecFinDis: lastDay,
        diasDis: 4,
        diasHabiles: 5,
        fechaRetorno: addDays(lastDay, 1),
      });
      return req?.id ?? '';
    }
    const around = () => {
      const t = todayBogota();
      return [-2, -1, 0, 1, 2].map((n) => addDays(t, n));
    };
    const annulWith = (id: string, enjoyedUntil?: 'YESTERDAY' | 'TODAY') =>
      send(adm, 'post', `/admin/vacations/${id}/annul`, {
        reason: 'El empleado debe volver al trabajo',
        ...(enjoyedUntil ? { enjoyedUntil } : {}),
      });

    it('en curso: por omisión devuelve solo los días no disfrutados (hasta ayer) y conserva los demás', async () => {
      const days = around();
      const id = await inProgress(days, days[4] ?? '');
      // la vista previa muestra las dos opciones antes de decidir
      const item = (
        await send(adm, 'get', '/admin/vacations/approved').expect(200)
      ).body.items.find((r: { id: string }) => r.id === id);
      expect(item.returnPreview.YESTERDAY).toMatchObject({ enjoyedDays: 2, returnedDays: 3 });
      expect(item.returnPreview.TODAY).toMatchObject({ enjoyedDays: 3, returnedDays: 2 });
      expect(item.returnPreview.YESTERDAY.cutoff).toBe(addDays(todayBogota(), -1));

      await annulWith(id).expect(204); // sin parámetro = hasta ayer
      // los 2 días disfrutados se cargan al período más antiguo (p2): devuelve 1; p1 devuelve sus 2
      expect(await disp(p2)).toBe(3);
      expect(await disp(p1)).toBe(10);
      const [vac] = await db.select().from(vacaciones).where(eq(vacaciones.requestId, id));
      expect(vac).toMatchObject({
        diasDevueltos: 3,
        diasDisfrutados: 2,
        disfrutadosHasta: addDays(todayBogota(), -1),
      });
      const action = (
        await db.select().from(vacationActions).where(eq(vacationActions.requestId, id))
      ).find((a) => a.action === 'ANULAR');
      expect(action?.comment).toContain('Se conservan 2 días ya disfrutados');
      const adj = (await db.select().from(progVacAdjustments)).map((a) => a.reason).join('\n');
      expect(adj).toContain('se devuelven 3');
    });

    it('en curso: quien anula puede contar hoy como disfrutado', async () => {
      const days = around();
      const id = await inProgress(days, days[4] ?? '');
      await annulWith(id, 'TODAY').expect(204);
      expect(await disp(p2)).toBe(2); // los 3 días disfrutados quedan descontados del más antiguo
      expect(await disp(p1)).toBe(10);
      const [vac] = await db.select().from(vacaciones).where(eq(vacaciones.requestId, id));
      expect(vac).toMatchObject({
        diasDevueltos: 2,
        diasDisfrutados: 3,
        disfrutadosHasta: todayBogota(),
      });
    });

    it('en curso: el último día con «hasta hoy» no queda nada por devolver; con «hasta ayer» sí', async () => {
      const t = todayBogota();
      const id = await inProgress(
        [addDays(t, -4), addDays(t, -3), addDays(t, -2), addDays(t, -1), t],
        t,
      );
      const res = await annulWith(id, 'TODAY').expect(409);
      expect(res.body.code).toBe('NOTHING_TO_RETURN');
      expect(await status(id)).toBe('APROBADA');
      expect(await disp(p2)).toBe(2); // nada cambió
      await annulWith(id, 'YESTERDAY').expect(204); // hoy aún no cuenta: queda 1 día por devolver
      expect(await disp(p2)).toBe(2); // 3 disfrutados, todos de este período
      expect(await disp(p1)).toBe(9); // 1 disfrutado y 1 devuelto
    });

    it('una opción inválida se rechaza', async () => {
      const days = around();
      const id = await inProgress(days, days[4] ?? '');
      await send(adm, 'post', `/admin/vacations/${id}/annul`, {
        reason: 'El empleado debe volver al trabajo',
        enjoyedUntil: 'TOMORROW',
      }).expect(400);
      expect(await status(id)).toBe('APROBADA');
    });

    it('no anula un disfrute que ya terminó, y devuelve los días a la versión vigente de un período reemplazado', async () => {
      const id = await approved('2026-03-02', 5);
      // ya terminó: no se corrige
      await db.update(vacaciones).set({ fecFinDis: past() });
      const ended = await annul(adm, id).expect(409);
      expect(ended.body.code).toBe('ENDED');
      expect(await status(id)).toBe('APROBADA');

      // aún no termina, pero la importación reemplazó el período: los días vuelven a la versión vigente
      await notStarted();
      await db.update(progVac).set({ active: false }).where(eq(progVac.id, p1));
      const [orig] = await db.select().from(progVac).where(eq(progVac.id, p1));
      const [fresh] = await db
        .insert(progVac)
        .values({
          nIde: '100',
          nCont: '1',
          perIni: orig?.perIni ?? '',
          perFin: orig?.perFin ?? '',
          dias: 15,
          disp: 3,
        })
        .returning({ id: progVac.id });
      await annul(adm, id).expect(204);
      expect(await disp(fresh?.id ?? '')).toBe(8); // 3 + 5
      expect(await disp(p1)).toBe(5); // la versión reemplazada no se toca
    });

    it('si el período ya no existe, no anula y lo explica', async () => {
      const id = await approved('2026-03-02', 5);
      await notStarted();
      await db.update(progVac).set({ active: false }).where(eq(progVac.id, p1));
      const res = await annul(adm, id).expect(409);
      expect(res.body.code).toBe('PERIOD_GONE');
      expect(await status(id)).toBe('APROBADA');
    });
  });

  describe('suplencias de quien aprueba', () => {
    const d = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const designate = (s: Sess, substituteAccountId: string, from = d(0), to = d(3)) =>
      send(s, 'post', '/me/substitutions', { substituteAccountId, validFrom: from, validTo: to });
    const mine = async (s: Sess) => (await send(s, 'get', '/me/substitutions').expect(200)).body;
    let dir: Sess;
    beforeEach(async () => {
      dir = await person('250', 'd@x.co', [{ role: 'AREA_DIRECTOR', area: true }]);
    });

    it('al designar: solo aprueban, con suplente aprobador de la misma empresa, fechas válidas y sin cruces', async () => {
      const gb = await person(
        '810',
        'gb@x.co',
        [{ role: 'VACATION_FINAL_APPROVER', company: 'GB' }],
        '99999',
      );
      const code = async (r: request.Test, status: number) => {
        const res = await r;
        expect(res.status).toBe(status);
        return res.body.code as string | undefined;
      };
      // quién puede: un empleado sin rol que apruebe no designa
      expect(await code(designate(emp, dir.id), 403)).toBe('NOT_APPROVER');
      // quién puede ser suplente: él mismo no; un empleado sin rol no; otra empresa no
      expect(await code(designate(mgr, mgr.id), 400)).toBe('SELF');
      expect(await code(designate(mgr, emp.id), 400)).toBe('SUBSTITUTE_NOT_ELIGIBLE');
      expect(await code(designate(mgr, gb.id), 400)).toBe('NO_COMMON_COMPANY');
      // fechas: pasado, fin antes del inicio, más de 90 días
      expect(await code(designate(mgr, dir.id, d(-1), d(2)), 400)).toBe('PAST_START');
      expect(await code(designate(mgr, dir.id, d(5), d(2)), 400)).toBe('INVALID_DATES');
      expect(await code(designate(mgr, dir.id, d(0), d(90)), 400)).toBe('TOO_LONG'); // 91 días
      const ok = await designate(mgr, dir.id, d(0), d(89)).expect(201); // 90 días exactos
      // un titular no tiene dos suplencias a la vez
      expect(await code(designate(mgr, fin.id, d(10), d(12)), 422)).toBe('OVERLAP');
      // sin cadenas: el suplente no puede a su vez designar a otro en las mismas fechas
      expect(await code(designate(dir, fin.id, d(1), d(2)), 422)).toBe('CHAIN');
      // candidatos: aprobadores de la misma empresa, nunca él mismo ni otra empresa
      const names = (await send(mgr, 'get', '/me/substitutions/candidates').expect(200)).body.map(
        (c: { name: string }) => c.name,
      );
      expect(names).toEqual(['Persona 250', 'Persona 300']);
      // lo suyo
      const m = await mine(mgr);
      expect(m.asTitular).toHaveLength(1);
      expect(m.asTitular[0]).toMatchObject({
        id: ok.body.id,
        substitute: 'Persona 250',
        phase: 'VIGENTE',
      });
      expect((await mine(dir)).asSubstitute[0]).toMatchObject({ titular: 'Persona 200' });
      const acts = (await db.select().from(auditLogs)).map((l) => l.action);
      expect(acts).toContain('SUBSTITUTION_CREATE');
    });

    it('en suplencia decide el suplente y no el titular; el rol del suplente basta; al terminar vuelve el titular', async () => {
      const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
      const sub = await designate(mgr, dir.id).expect(201);

      // el titular en suplencia no la decide; el suplente la ve y la decide con su propio rol
      expect(
        (await send(mgr, 'get', '/approvals/vacations/manager').expect(200)).body,
      ).toHaveLength(0);
      await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(404);
      expect(
        (await send(dir, 'get', '/approvals/vacations/manager').expect(200)).body,
      ).toHaveLength(1);
      await send(dir, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(200);
      expect(await status(a.body.id)).toBe('PENDIENTE_FINAL');
      const [act] = await db
        .select()
        .from(vacationActions)
        .where(eq(vacationActions.action, 'APROBAR_JEFE'));
      expect(act).toMatchObject({ actorAccountId: dir.id, onBehalfOfAccountId: mgr.id });

      // el detalle: el titular la ve pero no se le ofrece decidir; el suplente sí
      expect(
        (await send(mgr, 'get', `/me/vacations/${a.body.id}`).expect(200)).body.isManager,
      ).toBe(false);
      expect(
        (await send(dir, 'get', `/me/vacations/${a.body.id}`).expect(200)).body.isManager,
      ).toBe(true);

      // otra solicitud nueva, ya con el titular de vuelta tras terminar la suplencia
      const b = await submit('2026-04-06', [{ progVacId: p1, days: 1 }]).expect(201);
      await send(mgr, 'post', `/me/substitutions/${sub.body.id}/end`).expect(204);
      await send(mgr, 'post', `/me/substitutions/${sub.body.id}/end`).expect(422); // ya terminada
      await send(dir, 'post', `/approvals/vacations/manager/${b.body.id}/approve`).expect(404);
      await send(mgr, 'post', `/approvals/vacations/manager/${b.body.id}/approve`).expect(200);
      // nadie más puede terminar la suplencia
      const other = await designate(mgr, dir.id, d(20), d(21)).expect(201);
      await send(dir, 'post', `/me/substitutions/${other.body.id}/end`).expect(404);
      await send(emp, 'post', `/me/substitutions/${other.body.id}/end`).expect(404);
    });

    it('la aprobación final se puede suplir con cualquier rol que apruebe, y la constancia lo dice', async () => {
      const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
      await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(200);
      await designate(fin, mgr.id).expect(201); // el jefe suple al aprobador final

      // el titular en suplencia ya no decide; el suplente (sin el rol de aprobación final) sí
      expect((await send(fin, 'get', '/approvals/vacations/final').expect(200)).body).toHaveLength(
        0,
      );
      await send(fin, 'post', `/approvals/vacations/final/${a.body.id}/approve`).expect(403);
      expect((await send(mgr, 'get', '/approvals/vacations/final').expect(200)).body).toHaveLength(
        1,
      );
      await send(mgr, 'post', `/approvals/vacations/final/${a.body.id}/approve`).expect(200);
      expect(await status(a.body.id)).toBe('APROBADA');

      const text = await pdfText(body(await binary(pdf(emp, a.body.id)).expect(200)));
      expect(text).toContain('Aprobación final');
      expect(text).toContain('En suplencia de Persona 300');
      const [fa] = await db
        .select()
        .from(vacationActions)
        .where(eq(vacationActions.action, 'APROBAR_FINAL'));
      expect(fa).toMatchObject({ actorAccountId: mgr.id, onBehalfOfAccountId: fin.id });
    });

    it('Gestión Humana las anula con motivo, ve todas y la suplencia anulada deja de regir', async () => {
      const a = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
      const sub = await designate(mgr, dir.id).expect(201);
      await send(emp, 'get', '/admin/substitutions').expect(403);
      await send(mgr, 'post', `/admin/substitutions/${sub.body.id}/annul`, {
        reason: 'No me corresponde anularla',
      }).expect(403);
      await send(adm, 'post', `/admin/substitutions/${sub.body.id}/annul`, {
        reason: 'corto',
      }).expect(400);

      const list = (await send(adm, 'get', '/admin/substitutions?status=ACTIVA').expect(200)).body;
      expect(list.total).toBe(1);
      expect(list.items[0]).toMatchObject({
        titular: 'Persona 200',
        substitute: 'Persona 250',
        phase: 'VIGENTE',
      });
      expect((await send(adm, 'get', '/admin/substitutions?q=250').expect(200)).body.total).toBe(1);
      expect((await send(adm, 'get', '/admin/substitutions?q=zzz').expect(200)).body.total).toBe(0);
      await send(adm, 'get', '/admin/substitutions?status=X').expect(400);

      await send(adm, 'post', `/admin/substitutions/${sub.body.id}/annul`, {
        reason: 'Se designó a la persona equivocada',
      }).expect(204);
      await send(adm, 'post', `/admin/substitutions/${sub.body.id}/annul`, {
        reason: 'Se designó a la persona equivocada',
      }).expect(422);
      expect(
        (await send(adm, 'get', '/admin/substitutions?status=ANULADA').expect(200)).body.total,
      ).toBe(1);
      // ya no rige: el titular vuelve a decidir y el suplente pierde el acceso
      expect(
        (await send(dir, 'get', '/approvals/vacations/manager').expect(200)).body,
      ).toHaveLength(0);
      await send(dir, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(404);
      await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(200);
      const acts = (await db.select().from(auditLogs)).map((l) => l.action);
      expect(acts).toContain('SUBSTITUTION_ANNUL');
    });
  });

  /** Carga la firma de quien aprueba (multipart con consentimiento). */
  const enrollSig = (s: Sess, file: Buffer | null, consent = 'true') => {
    const r = request(srv())
      .post('/me/approver-signature')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf)
      .field('consent', consent);
    return file ? r.attach('file', file, { filename: 'firma.png', contentType: 'image/png' }) : r;
  };

  it('la firma del aprobador: solo la cargan quienes aprueban, con consentimiento y una imagen válida', async () => {
    await enrollSig(emp, png(200, 100)).expect(403); // un empleado no aprueba
    await enrollSig(mgr, png(200, 100), 'false').expect(400); // sin consentimiento
    await enrollSig(mgr, png(20, 20)).expect(400); // demasiado pequeña
    await enrollSig(mgr, Buffer.from('no es una imagen')).expect(400);
    await enrollSig(mgr, null).expect(400); // sin archivo

    let st = (await send(mgr, 'get', '/me/approver-signature').expect(200)).body;
    expect(st).toMatchObject({ eligible: true, enrolled: false });
    expect((await send(emp, 'get', '/me/approver-signature').expect(200)).body.eligible).toBe(
      false,
    );

    await enrollSig(mgr, png(200, 100)).expect(200);
    st = (await send(mgr, 'get', '/me/approver-signature').expect(200)).body;
    expect(st).toMatchObject({ eligible: true, enrolled: true });
    expect(st.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(st)).not.toContain('PNG'); // nunca la imagen en el estado

    // la imagen solo la ve su titular; el empleado no tiene firma
    const img = await request(srv()).get('/me/approver-signature/image').set('Cookie', mgr.cookie);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    await request(srv()).get('/me/approver-signature/image').set('Cookie', emp.cookie).expect(404);

    // reemplazar es cargar otra; retirar la borra y repetirlo no existe
    await enrollSig(mgr, png(300, 120, 0x55)).expect(200);
    const del = () =>
      request(srv())
        .delete('/me/approver-signature')
        .set('Cookie', mgr.cookie)
        .set('X-CSRF-Token', mgr.csrf);
    await del().expect(204);
    await del().expect(404);
    await request(srv()).get('/me/approver-signature').expect(401);

    const acts = (await db.select().from(auditLogs)).map((l) => l.action);
    expect(acts).toContain('APPROVER_SIGNATURE_ENROLL');
    expect(acts).toContain('APPROVER_SIGNATURE_REMOVE');
  });

  it('la constancia lleva las firmas de quienes aprobaron, con su cargo; sin imagen lo dice', async () => {
    const images = (pdfBuf: Buffer) =>
      (pdfBuf.toString('latin1').match(/\/Subtype \/Image/g) ?? []).length;

    // sin firmas cargadas: el bloque existe, con los cargos y la aclaración
    const sin = await approved('2026-03-02', 2);
    const noSig = body(await binary(pdf(emp, sin)).expect(200));
    const t0 = await pdfText(noSig);
    expect(t0).toContain('Firmas');
    expect(t0).toContain('Jefe de área');
    expect(t0).toContain('Aprobación final');
    expect(t0.match(/Firma en imagen no registrada/g)).toHaveLength(2);
    const base = images(noSig); // el logo de la empresa también es una imagen

    // con las dos firmas cargadas salen como imagen, y la constancia ya emitida no cambia
    await enrollSig(mgr, png(240, 100)).expect(200);
    await enrollSig(fin, png(260, 110, 0x44)).expect(200);
    const con = await approved('2026-04-06', 2);
    const signed = body(await binary(pdf(emp, con)).expect(200));
    const t1 = await pdfText(signed);
    expect(t1).not.toContain('Firma en imagen no registrada');
    expect(t1).toContain('Persona 200');
    expect(t1).toContain('Persona 300');
    expect(images(signed)).toBe(base + 2);
    expect(body(await binary(pdf(emp, sin)).expect(200)).equals(noSig)).toBe(true);

    // retirar la firma después no altera lo ya emitido
    await request(srv())
      .delete('/me/approver-signature')
      .set('Cookie', mgr.cookie)
      .set('X-CSRF-Token', mgr.csrf)
      .expect(204);
    expect(body(await binary(pdf(emp, con)).expect(200)).equals(signed)).toBe(true);
  });

  it('la descargan el dueño, su jefe y el aprobador final de la empresa; nadie más', async () => {
    const id = await approved();
    for (const who of [emp, mgr, fin]) await pdf(who, id).expect(200);
    const other = await person('600', 'o@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    const otherCo = await person(
      '810',
      'gb@x.co',
      [{ role: 'VACATION_FINAL_APPROVER', company: 'GB' }],
      '99999',
    );
    const stranger = await person('700', 'x7@x.co', [], '10400');
    for (const who of [other, otherCo, stranger, adm]) await pdf(who, id).expect(404);
    await request(srv()).get(`/me/vacations/${id}/pdf`).expect(401);
    await pdf(emp, '00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('solo existe la constancia de una solicitud aprobada', async () => {
    const pending = await submit('2026-03-02', [{ progVacId: p1, days: 2 }]).expect(201);
    await pdf(emp, pending.body.id).expect(404);
    await send(mgr, 'post', `/approvals/vacations/manager/${pending.body.id}/reject`, {
      reason: 'Hay cierre contable esa semana',
    }).expect(200);
    await pdf(emp, pending.body.id).expect(404);
    expect(raw.objects.size).toBe(0);
  });

  it('si el almacén falla al aprobar, la aprobación se mantiene y la constancia se genera al descargarla', async () => {
    raw.down = true;
    const id = await approved();
    expect(await status(id)).toBe('APROBADA'); // la aprobación no se pierde
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(5);
    expect(await db.select().from(vacationDocuments)).toHaveLength(0);
    await pdf(emp, id).expect(503); // sin almacén: reintentable
    raw.down = false;
    const first = await binary(pdf(emp, id)).expect(200);
    expect(await db.select().from(vacationDocuments)).toHaveLength(1);
    // la constancia no se vuelve a generar ni se sobrescribe: siempre el mismo documento
    const second = await binary(pdf(emp, id)).expect(200);
    expect(body(second).equals(body(first))).toBe(true);
    expect(raw.objects.size).toBe(1);
  });

  it('descargas simultáneas de una constancia pendiente generan una sola', async () => {
    raw.down = true;
    const id = await approved();
    raw.down = false;
    const res = await Promise.all([pdf(emp, id), pdf(mgr, id), pdf(fin, id)].map((r) => binary(r)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await db.select().from(vacationDocuments)).toHaveLength(1);
    expect(raw.objects.size).toBe(1);
    expect(body(res[1] as request.Response).equals(body(res[0] as request.Response))).toBe(true);
  });

  it('un objeto alterado, perdido o con otra huella no se entrega', async () => {
    const id = await approved();
    const [doc] = await db.select().from(vacationDocuments);
    const key = doc?.objectKey ?? '';
    const original = raw.objects.get(key) ?? { data: Buffer.alloc(0), contentType: 'x' };
    const tampered = Buffer.from(original.data);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    raw.objects.set(key, { data: tampered, contentType: 'application/pdf' });
    expect((await pdf(emp, id).expect(500)).body.code).toBe('STORAGE_INTEGRITY');
    raw.objects.delete(key);
    expect((await pdf(emp, id).expect(500)).body.code).toBe('STORAGE_INTEGRITY');
    raw.objects.set(key, original);
    await pdf(emp, id).expect(200);
    await db
      .update(vacationDocuments)
      .set({ sha256: 'f'.repeat(64) })
      .where(eq(vacationDocuments.id, doc?.id ?? ''));
    expect((await pdf(emp, id).expect(500)).body.code).toBe('STORAGE_INTEGRITY');
  });

  it('dos aprobaciones concurrentes no consumen más que DISP', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p2, days: 4 }]).expect(201);
    const b = await submit('2026-03-16', [{ progVacId: p2, days: 4 }]).expect(201);
    for (const x of [a, b])
      await send(mgr, 'post', `/approvals/vacations/manager/${x.body.id}/approve`).expect(200);
    const res = await Promise.all([
      send(fin, 'post', `/approvals/vacations/final/${a.body.id}/approve`),
      send(fin, 'post', `/approvals/vacations/final/${b.body.id}/approve`),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.select().from(progVac).where(eq(progVac.id, p2)))[0]?.disp).toBe(1);
    expect(await db.select().from(vacaciones)).toHaveLength(1);
  });

  it('si el calendario cambia antes de la aprobación final, no se aprueba', async () => {
    const a = await submit('2026-03-02', [{ progVacId: p1, days: 5 }]).expect(201);
    await send(mgr, 'post', `/approvals/vacations/manager/${a.body.id}/approve`).expect(200);
    // nueva versión publicada del año con un festivo dentro del intervalo
    await db
      .update(holidayCalendars)
      .set({ status: 'REEMPLAZADO' })
      .where(sql`${holidayCalendars.year} = 2026`);
    await calendar(2026, ['2026-03-04', '2026-03-23'], 2);
    await send(fin, 'post', `/approvals/vacations/final/${a.body.id}/approve`).expect(409);
    expect(await status(a.body.id)).toBe('PENDIENTE_FINAL');
    expect(await db.select().from(vacaciones)).toHaveLength(0);
    expect((await db.select().from(progVac).where(eq(progVac.id, p1)))[0]?.disp).toBe(10);
    await send(fin, 'post', `/approvals/vacations/final/${a.body.id}/reject`, {
      reason: 'Debe recalcularse con el nuevo calendario',
    }).expect(200);
    expect(await status(a.body.id)).toBe('RECHAZADA');
  });
});
