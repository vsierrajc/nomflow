import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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
  certificateSigners,
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
/** PNG sólido válido de w x h, suficiente para probar la carga de la firma. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x22)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
  const enrollSig = (
    key: string,
    id: string,
    o: { consent?: string; file?: Buffer; name?: string } = {},
  ) =>
    request(srv())
      .post(`/me/certificate-signer/${id}/signature`)
      .set('Cookie', sess[key]?.cookie ?? '')
      .set('X-CSRF-Token', sess[key]?.csrf ?? '')
      .field('consent', o.consent ?? 'true')
      .attach('file', o.file ?? png(200, 100), {
        filename: o.name ?? 'firma.png',
        contentType: 'image/png',
      });
  /** Designa a una persona como firmante (lo hace el administrador); ella carga su firma. */
  async function makeSigner(
    key: string,
    o: { title: string; tier?: 'PRINCIPAL' | 'RESPALDO'; enroll?: boolean },
  ) {
    await person(key);
    const res = await call('ADM', 'post', '/admin/labor-certificates/signers/GA', {
      nIde: key,
      title: o.title,
      tier: o.tier ?? 'PRINCIPAL',
    }).expect(201);
    if (o.enroll !== false) await enrollSig(key, res.body.id as string).expect(200);
    return res.body.id as string;
  }
  const settings = (over: object = {}) => ({
    mode: 'AMBOS',
    docCode: 'GH-FO-012',
    docVersion: '03',
    docDate: '2026-01-15',
    city: 'Barranquilla',
    footerText: 'NIT 800.000.000-1\nTel. 605 000 0000',
    maxPerDay: 10,
    ...over,
  });

  beforeEach(async () => {
    store.objects.clear();
    await db.execute(
      sql`TRUNCATE certificate_requests, certificate_signers, certificate_templates, certificate_settings, catalog_entries, companies, sessions, role_assignments, accounts, employee_snapshots, audit_logs CASCADE`,
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
    await makeSigner('DIRGH', { title: 'Directora de Gestión Humana' });
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
    // firma: nombre y cargo de quien firma, y la evidencia queda en el historial
    expect(text).toContain('PERSONA DIRGH');
    expect(text).toContain('Directora de Gestión Humana');
    expect(text).not.toContain('{{');
    expect(text).not.toContain('2.500.000'); // el salario solo sale si la plantilla lo incluye
    expect(text).not.toContain('A QUIEN'); // general: sin destinatario
    // el PDF queda guardado en el almacén de objetos, con su huella
    const [row] = await db.select().from(certificateRequests);
    expect(store.objects.has(row?.objectKey ?? '')).toBe(true);
    expect(row?.signerName).toBe('PERSONA DIRGH');
    expect(row?.signerTitle).toBe('Directora de Gestión Humana');
    expect(row?.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
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

  it('firma quien esté disponible: con dos principales el empleado elige; el de respaldo solo entra en su defecto', async () => {
    const fin = await makeSigner('DIRFIN', { title: 'Director Financiero' });
    const gg = await makeSigner('GERGEN', { title: 'Gerente General', tier: 'RESPALDO' });
    const opts = (await call('EMP', 'get', '/me/labor-certificates/options').expect(200)).body;
    expect(opts.signers.map((x: { title: string }) => x.title)).toEqual([
      'Directora de Gestión Humana',
      'Director Financiero',
    ]);
    // sin elegir: el primero; eligiendo: el elegido
    const a = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    const b = await call('EMP', 'post', '/me/labor-certificates', {
      kind: 'GENERAL',
      signerId: fin,
    }).expect(201);
    const textOf = async (id: string) =>
      pdfText(
        bin(await call('EMP', 'get', `/me/labor-certificates/${id}/pdf`).buffer(true).expect(200)),
      );
    expect(await textOf(a.body.id)).toContain('Directora de Gestión Humana');
    const tb = await textOf(b.body.id);
    expect(tb).toContain('Director Financiero');
    expect(tb).not.toContain('Gerente General');
    // el gerente general (respaldo) no se puede elegir mientras haya principales
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL', signerId: gg }).expect(
      400,
    );
    await call('EMP', 'post', '/me/labor-certificates', {
      kind: 'GENERAL',
      signerId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
    // si ningún principal está disponible, firma el gerente general
    const list = (await call('ADM', 'get', '/admin/labor-certificates/signers/GA').expect(200))
      .body;
    for (const p of list.filter((x: { tier: string }) => x.tier === 'PRINCIPAL'))
      await call('ADM', 'put', `/admin/labor-certificates/signers/GA/${p.id}`, {
        active: false,
      }).expect(200);
    const opts2 = (await call('EMP', 'get', '/me/labor-certificates/options').expect(200)).body;
    expect(opts2.signers.map((x: { title: string }) => x.title)).toEqual(['Gerente General']);
    const c = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    expect(await textOf(c.body.id)).toContain('Gerente General');
  });

  it('sin firmante disponible no se genera: falta la firma cargada, cuenta activa o rol vigente', async () => {
    await db.delete(certificateSigners);
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(409);
    // designado pero sin firma cargada: no cuenta
    const id = await makeSigner('SINFIRMA', { title: 'Director Financiero', enroll: false });
    expect(
      (await call('EMP', 'get', '/me/labor-certificates/options').expect(200)).body.signers,
    ).toEqual([]);
    const r = await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(409);
    expect(r.body.code).toBe('NO_SIGNER');
    await enrollSig('SINFIRMA', id).expect(200);
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    // cuenta bloqueada o rol vencido: deja de poder firmar
    await db.update(accounts).set({ status: 'BLOQUEADA' }).where(eq(accounts.nIde, 'SINFIRMA'));
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(409);
    await db.update(accounts).set({ status: 'ACTIVA' }).where(eq(accounts.nIde, 'SINFIRMA'));
    await db
      .update(roleAssignments)
      .set({ validTo: '2020-12-31' })
      .where(eq(roleAssignments.role, 'CERTIFICATE_APPROVER'));
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(409);
  });

  it('la firma la carga solo su titular, con consentimiento e imagen válida; nadie más la ve', async () => {
    const id = await makeSigner('DIRFIN', { title: 'Director Financiero', enroll: false });
    const mine = (await call('DIRFIN', 'get', '/me/certificate-signer').expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id,
      title: 'Director Financiero',
      tier: 'PRINCIPAL',
      enrolled: false,
    });
    await enrollSig('DIRFIN', id, { consent: 'false' }).expect(400); // sin consentimiento
    await enrollSig('DIRFIN', id, { file: Buffer.from('no es una imagen') }).expect(400);
    await enrollSig('DIRFIN', id, { file: png(20, 20) }).expect(400); // demasiado pequeña
    await enrollSig('EMP', id).expect(404); // otra persona no puede cargar la firma ajena
    await enrollSig('DIRFIN', id).expect(200);
    expect(
      (await call('DIRFIN', 'get', '/me/certificate-signer').expect(200)).body[0].enrolled,
    ).toBe(true);
    const img = await call('DIRFIN', 'get', `/me/certificate-signer/${id}/signature`)
      .buffer(true)
      .expect(200);
    expect(img.headers['content-type']).toContain('image/png');
    await call('EMP', 'get', `/me/certificate-signer/${id}/signature`).expect(404);
    await call('ADM', 'get', `/me/certificate-signer/${id}/signature`).expect(404); // ni siquiera el administrador
    const logs = (
      await db.select().from(auditLogs).where(eq(auditLogs.resource, 'certificate_signer'))
    ).map((l) => `${l.action}:${l.result}`);
    expect(logs).toContain('CERT_SIGNATURE_ENROLL:SUCCESS');
    expect(logs).toContain('CERT_SIGNATURE_ENROLL:CONSENT_REQUIRED');
    expect(logs).toContain('CERT_SIGNER_ADD:SUCCESS');
    // el listado del administrador no trae la imagen
    const adminList = JSON.stringify(
      (await call('ADM', 'get', '/admin/labor-certificates/signers/GA').expect(200)).body,
    );
    expect(adminList).not.toContain('signature"');
    expect(adminList).toContain('"enrolled":true');
  });

  it('el administrador designa firmantes: valida, evita duplicados, da el rol y exige sesión de administrador', async () => {
    const add = (body: object) => call('ADM', 'post', '/admin/labor-certificates/signers/GA', body);
    await person('NUEVO');
    await add({ nIde: 'NUEVO', title: 'ab', tier: 'PRINCIPAL' }).expect(400);
    await add({ nIde: 'NUEVO', title: 'Director Financiero', tier: 'OTRO' }).expect(400);
    await add({ nIde: 'NO-EXISTE', title: 'Director Financiero', tier: 'PRINCIPAL' }).expect(404);
    await add({ nIde: 'NUEVO', title: 'Director Financiero', tier: 'PRINCIPAL' }).expect(201);
    await add({ nIde: 'NUEVO', title: 'Director Financiero', tier: 'PRINCIPAL' }).expect(409);
    const [role] = await db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.role, 'CERTIFICATE_APPROVER'));
    expect(role?.companyCode).toBe('GA');
    await call('ADM', 'post', '/admin/labor-certificates/signers/ZZ', {
      nIde: 'NUEVO',
      title: 'Director',
      tier: 'PRINCIPAL',
    }).expect(404);
    await call('EMP', 'get', '/admin/labor-certificates/signers/GA').expect(403);
    await call('EMP', 'post', '/admin/labor-certificates/signers/GA', {
      nIde: 'NUEVO',
      title: 'Director',
      tier: 'PRINCIPAL',
    }).expect(403);
    // el historial muestra quién firmó
    await call('EMP', 'post', '/me/labor-certificates', { kind: 'GENERAL' }).expect(201);
    const hist = (await call('ADM', 'get', '/admin/labor-certificates/history').expect(200)).body;
    expect(hist.items[0]).toMatchObject({
      signerName: 'PERSONA DIRGH',
      signerTitle: 'Directora de Gestión Humana',
    });
  });
});
