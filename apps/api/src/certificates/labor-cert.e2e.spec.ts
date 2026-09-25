import { join } from 'node:path';
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
  auditLogs,
  catalogEntries,
  certificateRequests,
  companies,
  employeeSnapshots,
  roleAssignments,
} from '../db/schema';
import { MemoryObjectStore } from '../storage/memory-object-store';
import { OBJECT_STORE } from '../storage/object-store';

const url = process.env.DATABASE_URL;
const PASSWORD = 'Clave-Definitiva-1';
type Sess = { cookie: string; csrf: string };

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
async function pdfPages(buf: Buffer): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts =
    join(process.cwd(), '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
  return (
    await pdfjs.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: fonts, verbosity: 0 })
      .promise
  ).numPages;
}
const bin = (res: request.Response) => Buffer.from(res.body as Buffer);

describe.skipIf(!url)('certificado laboral (HTTP + PostgreSQL)', () => {
  const ctx = createDb(url ?? '');
  const db = ctx.db;
  const store = new MemoryObjectStore();
  let app: INestApplication;
  const srv = () => app.getHttpServer();
  const sess: Record<string, Sess> = {};

  beforeAll(async () => {
    process.env.OBJECT_ENCRYPTION_KEY = 'clave-de-objetos-de-prueba-con-mas-de-32-caracteres';
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

  async function person(
    key: string,
    o: { est?: 'V' | 'C'; admin?: boolean; cargo?: string | null } = {},
  ) {
    const email = `${key.toLowerCase()}@x.co`;
    await db.insert(employeeSnapshots).values({
      nIde: key,
      nCont: '1',
      email,
      est: o.est ?? 'V',
      nombre: `PERSONA ${key}`,
      cEmp: 'GA',
      cCar: o.cargo === null ? null : 'CA1',
      cArea: 'AR1',
      cCos: 'CC1',
      tipoContrato: '01',
      fIni: '2020-02-03',
      sAct: '2500000',
    });
    const [a] = await db
      .insert(accounts)
      .values({
        nIde: key,
        email,
        passwordHash: await hashPassword(PASSWORD),
        status: 'ACTIVA',
        mustChangePassword: false,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: accounts.id });
    if (o.admin)
      await db
        .insert(roleAssignments)
        .values({ accountId: a?.id ?? '', role: 'HR_ADMIN', validFrom: '2020-01-01' });
    const res = await request(srv())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    sess[key] = {
      cookie: String(res.headers['set-cookie']?.[0]).split(';')[0] ?? '',
      csrf: res.body.csrfToken as string,
    };
  }
  const call = (k: string, method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const agent = request(srv());
    const r = agent[method](path).set('Cookie', sess[k]?.cookie ?? '');
    return method === 'get' ? r : r.set('X-CSRF-Token', sess[k]?.csrf ?? '').send(body ?? {});
  };
  const settings = (over: object = {}) => ({
    mode: 'AMBOS',
    docCode: 'GH-FO-012',
    docVersion: '03',
    docDate: '2026-01-15',
    city: 'Barranquilla',
    signerName: 'ALEXANDRA CARRILLO',
    signerTitle: 'Directora de Gestión Humana',
    footerText: 'NIT 800.000.000-1\nTel. 605 000 0000',
    maxPerDay: 10,
    ...over,
  });

  beforeEach(async () => {
    store.objects.clear();
    await db.execute(
      sql`TRUNCATE certificate_requests, certificate_templates, certificate_settings, catalog_entries, companies, sessions, role_assignments, accounts, employee_snapshots, audit_logs CASCADE`,
    );
    await db.insert(companies).values({
      cEmp: 'GA',
      nombre: 'GRUPO ALIMENTARIO DEL ATLANTICO S.A.',
      sigla: 'GA',
      direccion: 'CL 1 38-121',
    });
    for (const [type, code, name] of [
      ['AREA', 'AR1', 'PRODUCCIÓN'],
      ['CARGO', 'CA1', 'ANALISTA DE CALIDAD'],
      ['CCOSTO', 'CC1', 'PLANTA'],
    ] as const)
      await db.insert(catalogEntries).values({ type, cEmp: 'GA', code, name });
    await db
      .insert(catalogEntries)
      .values({ type: 'TIPO_CONTRATO', cEmp: '', code: '01', name: 'TÉRMINO INDEFINIDO' });
    await person('EMP');
    await person('ADM', { admin: true });
    await call('ADM', 'put', '/admin/labor-certificates/config/GA/settings', settings()).expect(
      200,
    );
  });

  it('el empleado genera el certificado general con sus datos, logo, código del documento y pie', async () => {
    const opts = await call('EMP', 'get', '/me/labor-certificates/options').expect(200);
    expect(opts.body.kinds).toEqual(['GENERAL', 'DIRIGIDO']);
    const made = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(
      201,
    );
    expect(made.body).toMatchObject({ kind: 'GENERAL', docCode: 'GH-FO-012', docVersion: '03' });

    const res = await call('EMP', 'get', `/me/labor-certificates/${made.body.id}/pdf`)
      .buffer(true)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const text = await pdfText(bin(res));
    expect(text).toContain('CERTIFICADO LABORAL');
    expect(text).toContain('GRUPO ALIMENTARIO DEL ATLANTICO S.A.');
    expect(text).toContain('PERSONA EMP');
    expect(text).toContain('3 de febrero de 2020');
    expect(text).toContain('ANALISTA DE CALIDAD');
    expect(text).toContain('PRODUCCIÓN');
    expect(text).toContain('TÉRMINO INDEFINIDO');
    expect(await pdfPages(bin(res))).toBe(1); // el pie no abre una segunda página
    expect(text).toContain('Tel. 605 000 0000');
    expect(text).toMatch(/Ref\. [0-9A-F]{8}/);
    expect(text).toContain('Código: GH-FO-012');
    expect(text).toContain('Versión: 03');
    expect(text).toContain('NIT 800.000.000-1');
    expect(text).toContain('CL 1 38-121');
    expect(text).toContain('ALEXANDRA CARRILLO');
    expect(text).not.toContain('{{');
    expect(text).not.toContain('2.500.000'); // el salario solo sale si la plantilla lo incluye
    expect(text).not.toContain('A QUIEN'); // general: sin destinatario
    // el PDF queda guardado en el almacén de objetos, con su huella
    const [row] = await db.select().from(certificateRequests);
    expect(store.objects.has(row?.objectKey ?? '')).toBe(true);
  });

  it('el certificado dirigido exige y muestra el destinatario', async () => {
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'DIRIGIDO' }).expect(400);
    await call('EMP', 'post', '/me/labor-certificates', {
      kind: 'DIRIGIDO',
      addressee: 'ab',
    }).expect(400);
    const made = await call('EMP', 'post', '/me/labor-certificates', {
      kind: 'DIRIGIDO',
      addressee: 'BANCO EJEMPLO S.A.',
    }).expect(201);
    const res = await call('EMP', 'get', `/me/labor-certificates/${made.body.id}/pdf`)
      .buffer(true)
      .expect(200);
    const text = await pdfText(bin(res));
    expect(text).toContain('BANCO EJEMPLO S.A.');
    const list = await call('EMP', 'get', '/me/labor-certificates').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      kind: 'DIRIGIDO',
      addressee: 'BANCO EJEMPLO S.A.',
      archived: false,
    });
  });

  it('la modalidad que se ofrece depende de lo que configuró el administrador', async () => {
    await call(
      'ADM',
      'put',
      '/admin/labor-certificates/config/GA/settings',
      settings({ mode: 'GENERAL' }),
    ).expect(200);
    expect(
      (await call('EMP', 'get', '/me/labor-certificates/options').expect(200)).body.kinds,
    ).toEqual(['GENERAL']);
    await call('EMP', 'post', '/me/labor-certificates', {
      kind: 'DIRIGIDO',
      addressee: 'BANCO EJEMPLO',
    }).expect(400);
    // sin indicar modalidad: se usa la única disponible
    await call('EMP', 'post', '/me/labor-certificates', {}).expect(201);
    await call(
      'ADM',
      'put',
      '/admin/labor-certificates/config/GA/settings',
      settings({ mode: 'DIRIGIDO' }),
    ).expect(200);
    expect(
      (await call('EMP', 'get', '/me/labor-certificates/options').expect(200)).body.kinds,
    ).toEqual(['DIRIGIDO']);
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(400);
    await call('EMP', 'post', '/me/labor-certificates', { addressee: 'BANCO EJEMPLO' }).expect(201);
  });

  it('el contenido es una tabla editable: una versión nueva cambia solo las emisiones futuras', async () => {
    const first = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(
      201,
    );
    const cfg = (await call('ADM', 'get', '/admin/labor-certificates/config/GA').expect(200)).body;
    expect(cfg.templates.filter((t: { kind: string }) => t.kind === 'GENERAL')).toHaveLength(1);
    expect(Object.keys(cfg.variables)).toContain('DESTINATARIO');
    const saved = await call(
      'ADM',
      'put',
      '/admin/labor-certificates/config/GA/templates/GENERAL',
      {
        title: 'CERTIFICACIÓN LABORAL',
        body: '{{EMPRESA_NOMBRE}} certifica que {{NOMBRE}} devenga {{S_ACT}} ({{S_ACT_LETRAS}}) como {{CARGO}}.',
      },
    ).expect(200);
    expect(saved.body.version).toBe(2);
    const second = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(
      201,
    );
    const newer = await pdfText(
      bin(
        await call('EMP', 'get', `/me/labor-certificates/${second.body.id}/pdf`)
          .buffer(true)
          .expect(200),
      ),
    );
    expect(newer).toContain('CERTIFICACIÓN LABORAL');
    expect(newer).toContain('dos millones quinientos mil pesos m/cte');
    expect(newer).toContain('2.500.000');
    const older = await pdfText(
      bin(
        await call('EMP', 'get', `/me/labor-certificates/${first.body.id}/pdf`)
          .buffer(true)
          .expect(200),
      ),
    );
    expect(older).toContain('CERTIFICADO LABORAL'); // lo ya emitido no cambia
    expect(older).not.toContain('2.500.000');
    const all = (await call('ADM', 'get', '/admin/labor-certificates/config/GA').expect(200)).body
      .templates;
    expect(
      all
        .filter((t: { kind: string }) => t.kind === 'GENERAL')
        .map((t: { version: number; status: string }) => `${t.version}:${t.status}`),
    ).toEqual(['2:VIGENTE', '1:RETIRADA']);
  });

  it('valida las plantillas y los parámetros', async () => {
    const put = (kind: string, body: object) =>
      call('ADM', 'put', `/admin/labor-certificates/config/GA/templates/${kind}`, body);
    const bad = await put('GENERAL', { title: 'T', body: 'Hola {{INVENTADA}}' }).expect(422);
    expect(bad.body.details.join(' ')).toContain('{{INVENTADA}}');
    await put('DIRIGIDO', { title: 'T', body: 'Sin destinatario {{NOMBRE}}' }).expect(422);
    await put('GENERAL', { title: 'T', body: 'Para {{DESTINATARIO}}' }).expect(422);
    await put('OTRO', { title: 'T', body: 'x' }).expect(400);
    for (const over of [
      { mode: 'X' },
      { docCode: '' },
      { maxPerDay: 0 },
      { city: '' },
      { footerText: 'a\nb\nc\nd\ne' },
    ])
      await call(
        'ADM',
        'put',
        '/admin/labor-certificates/config/GA/settings',
        settings(over),
      ).expect(400);
    await call('ADM', 'put', '/admin/labor-certificates/config/ZZ/settings', settings()).expect(
      404,
    );
  });

  it('si falta un dato que la plantilla usa, no genera y explica cuál', async () => {
    await person('SINCARGO', { cargo: null });
    const r = await call('SINCARGO', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(
      422,
    );
    expect(r.body.code).toBe('MISSING_DATA');
    expect(r.body.details).toContain('cargo');
    expect(await db.select().from(certificateRequests)).toHaveLength(0);
  });

  it('solo con contrato vigente, con límite diario y el empleado solo ve los suyos', async () => {
    await person('EXEMP');
    await db.update(employeeSnapshots).set({ est: 'C' }).where(eq(employeeSnapshots.nIde, 'EXEMP'));
    await call('EXEMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(409);
    await call(
      'ADM',
      'put',
      '/admin/labor-certificates/config/GA/settings',
      settings({ maxPerDay: 2 }),
    ).expect(200);
    const a = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(429);
    await person('OTRO');
    await call('OTRO', 'get', `/me/labor-certificates/${a.body.id}/pdf`).expect(404);
    expect((await call('OTRO', 'get', '/me/labor-certificates').expect(200)).body).toEqual([]);
    await request(srv()).get('/me/labor-certificates').expect(401);
  });

  it('el administrador consulta el historial de todas las solicitudes, con filtros, y descarga', async () => {
    await person('OTRO');
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    const d = await call('OTRO', 'post', '/me/labor-certificates', {
      kind: 'DIRIGIDO',
      addressee: 'NOTARÍA 5',
    }).expect(201);
    const all = (await call('ADM', 'get', '/admin/labor-certificates/history').expect(200)).body;
    expect(all.total).toBe(2);
    expect(all.items[0]).toMatchObject({
      nIde: 'OTRO',
      nombre: 'PERSONA OTRO',
      kind: 'DIRIGIDO',
      addressee: 'NOTARÍA 5',
      docCode: 'GH-FO-012',
      templateVersion: 1,
    });
    expect(JSON.stringify(all)).not.toContain('2500000'); // sin salarios
    expect(
      (await call('ADM', 'get', '/admin/labor-certificates/history?kind=GENERAL').expect(200)).body
        .total,
    ).toBe(1);
    expect(
      (await call('ADM', 'get', '/admin/labor-certificates/history?q=notar').expect(200)).body
        .total,
    ).toBe(1);
    expect(
      (await call('ADM', 'get', '/admin/labor-certificates/history?q=PERSONA EMP').expect(200)).body
        .total,
    ).toBe(1);
    expect(
      (await call('ADM', 'get', '/admin/labor-certificates/history?from=2099-01-01').expect(200))
        .body.total,
    ).toBe(0);
    await call('ADM', 'get', '/admin/labor-certificates/history?kind=X').expect(400);
    const pdf = await call('ADM', 'get', `/admin/labor-certificates/history/${d.body.id}/pdf`)
      .buffer(true)
      .expect(200);
    expect(await pdfText(bin(pdf))).toContain('NOTARÍA 5');
    // un empleado no entra a lo administrativo
    await call('EMP', 'get', '/admin/labor-certificates/history').expect(403);
    await call('EMP', 'get', '/admin/labor-certificates/config/GA').expect(403);
    await call('EMP', 'put', '/admin/labor-certificates/config/GA/settings', settings()).expect(
      403,
    );
    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resource, 'labor_certificate'));
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('LABOR_CERT_ISSUE');
    expect(actions).toContain('LABOR_CERT_DOWNLOAD');
    expect(actions).toContain('LABOR_CERT_SETTINGS_UPDATE');
  });

  it('vista previa con datos ficticios: no queda en el historial', async () => {
    const res = await call(
      'ADM',
      'post',
      '/admin/labor-certificates/config/GA/templates/DIRIGIDO/preview',
      {},
    )
      .buffer(true)
      .expect(200);
    const text = await pdfText(bin(res));
    expect(text).toContain('VISTA PREVIA');
    expect(text).toContain('QUIEN CORRESPONDA');
    const draft = await call(
      'ADM',
      'post',
      '/admin/labor-certificates/config/GA/templates/GENERAL/preview',
      { title: 'BORRADOR', body: 'Prueba {{NOMBRE}}' },
    )
      .buffer(true)
      .expect(200);
    expect(await pdfText(bin(draft))).toContain('BORRADOR');
    await call('ADM', 'post', '/admin/labor-certificates/config/GA/templates/GENERAL/preview', {
      title: 'X',
      body: '{{NADA}}',
    }).expect(422);
    expect(await db.select().from(certificateRequests)).toHaveLength(0);
  });

  it('el almacén de objetos caído responde 503 y no deja historial', async () => {
    store.down = true;
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(503);
    store.down = false;
    expect(await db.select().from(certificateRequests)).toHaveLength(0);
  });
});
