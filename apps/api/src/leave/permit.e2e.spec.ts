import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../accounts/password.service';
import { AppModule } from '../app.module';
import { createDb } from '../db/client';
import { runMigrations } from '../db/migrate';
import {
  accounts,
  areaManagerAssignments,
  employeeSnapshots,
  permitActions,
  permitRequests,
  permitSupports,
  permitTypes,
  progVac,
  roleAssignments,
  vacaciones,
  vacationRequests,
  vacationRevisions,
} from '../db/schema';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string; id: string };
type Role = (typeof roleAssignments.$inferInsert)['role'];
const PDF = Buffer.from('%PDF-1.4\n% soporte de prueba\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(20),
]);

describe.skipIf(!url)('permisos: tipos, solicitud y decisión del jefe (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  let adm: Sess;
  let emp: Sess;
  let mgr: Sess;
  let fin: Sess;
  let simple = '';
  let medical = '';
  let hourly = '';

  beforeAll(async () => {
    await runMigrations(url ?? '');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await ctx.pool.end();
  });

  async function person(
    nIde: string,
    email: string,
    roles: { role: Role; area?: boolean; company?: string }[] = [],
    cArea = '10300',
  ): Promise<Sess> {
    await db
      .insert(employeeSnapshots)
      .values({ nIde, nCont: '1', email, est: 'V', nombre: `Persona ${nIde}`, cEmp: 'GA', cArea });
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
    const res = await request(srv()).post('/auth/login').send({ email, password: PASSWORD });
    return {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
      id: a?.id ?? '',
    };
  }
  const send = (s: Sess, method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const r = request(srv())[method](path).set('Cookie', s.cookie);
    return method === 'get' ? r : r.set('X-CSRF-Token', s.csrf).send(body ?? {});
  };
  const form = (s: Sess, fields: Record<string, string>, file?: { buf: Buffer; name?: string }) => {
    const r = request(srv())
      .post('/me/permits')
      .set('Cookie', s.cookie)
      .set('X-CSRF-Token', s.csrf);
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    if (file) r.attach('support', file.buf, { filename: file.name ?? 'soporte.pdf' });
    return r;
  };
  const base = (over: Record<string, string> = {}) => ({
    typeId: simple,
    start: '2026-04-06',
    end: '2026-04-07',
    justification: 'Trámite personal ineludible',
    ...over,
  });
  const status = async (id: string) =>
    (await db.select().from(permitRequests).where(eq(permitRequests.id, id)))[0]?.status;

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE permit_actions, permit_supports, permit_requests, permit_types, vacaciones, vacation_actions, vacation_revision_allocations, vacation_revisions, vacation_requests, prog_vac_adjustments, prog_vac, area_manager_assignments, audit_logs, sessions, role_assignments, accounts, employee_snapshots CASCADE`,
    );
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
    const ins = async (
      v: Partial<typeof permitTypes.$inferInsert> & { code: string; name: string },
    ) => (await db.insert(permitTypes).values(v).returning({ id: permitTypes.id }))[0]?.id ?? '';
    simple = await ins({ code: 'PERSONAL', name: 'Permiso personal', maxDays: 3 });
    medical = await ins({ code: 'MEDICO', name: 'Cita médica', supportRequired: true });
    hourly = await ins({ code: 'HORAS', name: 'Permiso por horas', allowsHours: true });
  });

  it('el administrador gestiona los tipos; los demás no', async () => {
    const body = {
      code: 'LUTO',
      name: 'Licencia por luto',
      supportRequired: true,
      allowsHours: false,
      maxDays: 5,
      active: true,
    };
    await send(emp, 'post', '/admin/permit-types', body).expect(403);
    await send(mgr, 'get', '/admin/permit-types').expect(403);
    await send(fin, 'post', '/admin/permit-types', body).expect(403);
    await send(adm, 'post', '/admin/permit-types', { ...body, code: 'con espacio' }).expect(400);
    await send(adm, 'post', '/admin/permit-types', { ...body, maxDays: 0 }).expect(400);
    const created = await send(adm, 'post', '/admin/permit-types', body).expect(201);
    await send(adm, 'post', '/admin/permit-types', body).expect(409);
    await send(adm, 'put', `/admin/permit-types/${created.body.id}`, {
      ...body,
      active: false,
      version: 9,
    }).expect(409);
    await send(adm, 'put', `/admin/permit-types/${created.body.id}`, {
      ...body,
      name: 'Luto',
      active: false,
      version: 1,
    }).expect(200);
    // un tipo inactivo ya no se ofrece ni se acepta
    const offered = (await send(emp, 'get', '/me/permits/types').expect(200)).body.map(
      (t: { name: string }) => t.name,
    );
    expect(offered).not.toContain('Luto');
    await form(emp, base({ typeId: created.body.id })).expect(400);
  });

  it('camino completo: el jefe aprueba y no hay más aprobaciones ni consumo de PROG_VAC', async () => {
    await db.insert(progVac).values({
      nIde: '100',
      nCont: '1',
      perIni: '2025-01-01',
      perFin: '2025-12-31',
      dias: 15,
      disp: 10,
    });
    const created = await form(emp, base()).expect(201);
    const id = created.body.id as string;
    expect(await status(id)).toBe('PENDIENTE_JEFE');
    expect((await send(emp, 'get', '/me/permits').expect(200)).body[0]).toMatchObject({
      id,
      status: 'PENDIENTE_JEFE',
      typeName: 'Permiso personal',
      start: '2026-04-06',
      end: '2026-04-07',
    });
    const inbox = (await send(mgr, 'get', '/approvals/permits/manager').expect(200)).body;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].employee).toBe('Persona 100');
    await send(mgr, 'post', `/approvals/permits/manager/${id}/approve`).expect(200);
    expect(await status(id)).toBe('APROBADO');
    expect(
      (await db.select().from(permitActions).orderBy(permitActions.at)).map((a) => a.action),
    ).toEqual(['ENVIAR', 'APROBAR']);
    await send(mgr, 'post', `/approvals/permits/manager/${id}/approve`).expect(409);
    expect((await db.select().from(progVac))[0]?.disp).toBe(10); // no consume vacaciones
    expect(await db.select().from(vacaciones)).toHaveLength(0);
  });

  it('solo decide el jefe de área: el aprobador final y el administrador no intervienen', async () => {
    const id = (await form(emp, base()).expect(201)).body.id as string;
    // no existe bandeja ni acción de aprobación final para permisos
    await send(fin, 'post', `/approvals/permits/final/${id}/approve`).expect(404);
    await send(fin, 'get', '/approvals/permits/manager').expect(403);
    await send(fin, 'get', `/me/permits/${id}`).expect(404);
    await send(adm, 'post', `/approvals/permits/manager/${id}/approve`).expect(403);
    await send(adm, 'get', `/me/permits/${id}`).expect(404);
    await send(emp, 'post', `/approvals/permits/manager/${id}/approve`).expect(403);
    // otro jefe con el rol pero sin la asignación
    const other = await person('600', 'o@x.co', [{ role: 'AREA_MANAGER', area: true }]);
    await send(other, 'post', `/approvals/permits/manager/${id}/approve`).expect(404);
    await send(other, 'get', `/me/permits/${id}`).expect(404);
    expect((await send(other, 'get', '/approvals/permits/manager').expect(200)).body).toEqual([]);
    expect(await status(id)).toBe('PENDIENTE_JEFE');
    // sin sesión
    await request(srv()).get('/me/permits').expect(401);
    await request(srv()).post(`/approvals/permits/manager/${id}/approve`).expect(401);
    // el jefe pide su propio permiso: no puede aprobarlo
    const own = (await form(mgr, base({ start: '2026-05-04', end: '2026-05-04' })).expect(201)).body
      .id as string;
    await send(mgr, 'post', `/approvals/permits/manager/${own}/approve`).expect(403);
  });

  it('rechazo con motivo, cancelación y solicitudes de otro empleado', async () => {
    const a = (await form(emp, base()).expect(201)).body.id as string;
    await send(mgr, 'post', `/approvals/permits/manager/${a}/reject`, { reason: 'corto' }).expect(
      400,
    );
    await send(mgr, 'post', `/approvals/permits/manager/${a}/reject`, {
      reason: 'Hay cierre contable esa semana',
    }).expect(200);
    expect(await status(a)).toBe('RECHAZADO');
    const b = (await form(emp, base({ start: '2026-05-04', end: '2026-05-04' })).expect(201)).body
      .id as string;
    await send(emp, 'post', `/me/permits/${b}/cancel`).expect(200);
    expect(await status(b)).toBe('CANCELADO');
    await send(emp, 'post', `/me/permits/${b}/cancel`).expect(409);
    await send(mgr, 'post', `/approvals/permits/manager/${b}/approve`).expect(409);
    const det = (await send(emp, 'get', `/me/permits/${a}`).expect(200)).body;
    expect(det.actions.map((x: { action: string }) => x.action)).toEqual(['ENVIAR', 'RECHAZAR']);
    expect(det.actions[1].comment).toBe('Hay cierre contable esa semana');
    const c = await person('900', 'c@x.co');
    await send(c, 'post', `/me/permits/${a}/cancel`).expect(404);
    await send(c, 'get', `/me/permits/${a}`).expect(404);
  });

  it('validaciones al enviar: fechas, máximo de días, horas, justificación, cruces y jefe', async () => {
    await form(emp, base({ end: '2026-04-05' })).expect(400); // fin antes que inicio
    await form(emp, base({ start: '2026-02-30', end: '2026-03-01' })).expect(400);
    await form(emp, base({ end: '2026-04-10' })).expect(400); // 5 días > máximo de 3
    await form(emp, base({ justification: 'corta' })).expect(400);
    await form(emp, base({ typeId: '00000000-0000-4000-8000-000000000000' })).expect(400);
    await form(emp, base({ startTime: '08:00', endTime: '10:00' })).expect(400); // el tipo no admite horas
    const h = (over: Record<string, string>) =>
      form(emp, base({ typeId: hourly, start: '2026-04-06', end: '2026-04-06', ...over }));
    await h({ startTime: '10:00', endTime: '09:00' }).expect(400);
    await h({ startTime: '25:00', endTime: '26:00' }).expect(400);
    await h({ startTime: '08:00' }).expect(400); // falta la hora final
    await h({ end: '2026-04-07', startTime: '08:00', endTime: '09:00' }).expect(400); // horas en varios días
    await h({ startTime: '08:00', endTime: '10:00' }).expect(201);
    await h({ startTime: '09:00', endTime: '11:00' }).expect(409); // horarios cruzados
    await h({ startTime: '10:00', endTime: '12:00' }).expect(201); // mismo día, sin cruce
    await form(emp, base({ start: '2026-04-06', end: '2026-04-06' })).expect(409); // todo el día choca con las horas
    // choca con unas vacaciones aprobadas
    const [vr] = await db
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
        requestId: vr?.id ?? '',
        number: 1,
        startDate: '2026-06-01',
        endDate: '2026-06-05',
        calendarDiff: 4,
        businessDays: 5,
        returnDate: '2026-06-08',
        countedDays: [],
        calendarIds: [],
        proposedBy: emp.id,
        contentHash: 'h',
      })
      .returning({ id: vacationRevisions.id });
    await db.insert(vacaciones).values({
      requestId: vr?.id ?? '',
      revisionId: rev?.id ?? '',
      nIde: '100',
      nCont: '1',
      fecIniDis: '2026-06-01',
      fecFinDis: '2026-06-05',
      diasDis: 4,
      diasHabiles: 5,
      fechaRetorno: '2026-06-08',
    });
    await form(emp, base({ start: '2026-06-03', end: '2026-06-03' })).expect(409);
    await form(emp, base({ start: '2026-06-08', end: '2026-06-08' })).expect(201); // el día de retorno sí
    await db.delete(areaManagerAssignments);
    await form(emp, base({ start: '2026-07-06', end: '2026-07-06' })).expect(422); // sin jefe vigente
  });

  it('el soporte se valida por su contenido, es obligatorio según el tipo y solo lo ven las partes', async () => {
    await form(emp, base({ typeId: medical })).expect(400); // falta el soporte
    await form(emp, base({ typeId: medical }), {
      buf: Buffer.from('MZ ejecutable disfrazado'),
      name: 'x.pdf',
    }).expect(400);
    await form(emp, base({ typeId: medical }), {
      buf: Buffer.alloc(3 * 1024 * 1024, 1),
      name: 'grande.pdf',
    }).expect(413);
    const ok = await form(emp, base({ typeId: medical }), {
      buf: PDF,
      name: 'orden médica.pdf',
    }).expect(201);
    const [s] = await db.select().from(permitSupports);
    expect(s).toMatchObject({ contentType: 'application/pdf', sizeBytes: PDF.length });
    expect(s?.fileName).not.toMatch(/[^\w.\- ]/);
    const det = (await send(emp, 'get', `/me/permits/${ok.body.id}`).expect(200)).body;
    expect(det.support).toMatchObject({ contentType: 'application/pdf' });
    for (const who of [emp, mgr]) {
      const dl = await send(who, 'get', `/me/permits/${ok.body.id}/support`)
        .buffer(true)
        .parse((r, cb) => {
          const c: Buffer[] = [];
          r.on('data', (d: Buffer) => c.push(d));
          r.on('end', () => cb(null, Buffer.concat(c)));
        })
        .expect(200);
      expect(dl.headers['content-type']).toContain('application/pdf');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect((dl.body as Buffer).toString()).toContain('soporte de prueba');
    }
    const c = await person('900', 'c@x.co');
    await send(c, 'get', `/me/permits/${ok.body.id}/support`).expect(404);
    await send(fin, 'get', `/me/permits/${ok.body.id}/support`).expect(404);
    await send(adm, 'get', `/me/permits/${ok.body.id}/support`).expect(404);
    // un soporte opcional en un tipo que no lo exige también se valida, y acepta imágenes
    await form(emp, base({ start: '2026-08-03', end: '2026-08-03' }), {
      buf: PNG,
      name: 'foto.png',
    }).expect(201);
    expect((await db.select().from(permitSupports)).map((x) => x.contentType).sort()).toEqual([
      'application/pdf',
      'image/png',
    ]);
  });
});
