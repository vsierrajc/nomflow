import PDFDocument from 'pdfkit';
import type { Letterhead } from '../org/letterhead.service';

export interface VacationDocData {
  requestId: string;
  revision: number;
  /** Huella del contenido de la revisión aprobada (evidencia; no es una firma digital). */
  contentHash: string;
  employee: { name: string; nIde: string; nCont: string };
  company: { nombre: string; sigla: string; direccion: string } | null;
  logo: Buffer | null;
  /** Imágenes a todo el ancho de la página; si faltan se usa el encabezado de texto. */
  letterhead?: { header: Letterhead | null; footer: Letterhead | null };
  start: string;
  end: string;
  /** DIAS_DIS: diferencia literal en días calendario. */
  calendarDiff: number;
  /** DIAS_HABILES: los que se descuentan de lo disponible. */
  businessDays: number;
  returnDate: string;
  allocations: { perIni: string; perFin: string; days: number }[];
  actions: { label: string; name: string; at: Date; revision: number; comment: string | null }[];
  approvedAt: Date;
}

const LEFT = 40;
const PAGE_W = 612;
const PAGE_H = 792;
const RIGHT = PAGE_W - 40;
const dateFmt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});
const day = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
const clean = (v: string) =>
  Array.from(v, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .trim();

/**
 * Constancia de una solicitud de vacaciones aprobada. Distingue expresamente los días hábiles (que
 * se descuentan) de la diferencia en días calendario, para evitar interpretaciones erróneas (SSD 6.2).
 * La fecha de creación del PDF es la de la aprobación: el mismo dato produce el mismo documento.
 */
export function renderVacationPdf(
  d: VacationDocData,
  options: { compress?: boolean } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 40,
      compress: options.compress ?? true,
      info: {
        Title: 'Constancia de solicitud de vacaciones aprobada',
        Author: 'NOMFLOW',
        Producer: 'NOMFLOW',
        CreationDate: d.approvedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const header = d.letterhead?.header ?? null;
    let headerDrawn = false;
    if (header) {
      try {
        doc.image(header.data, 0, 0, { width: PAGE_W });
        headerDrawn = true;
        doc.x = LEFT;
        doc.y = header.heightPt + 14;
      } catch {
        headerDrawn = false;
      }
    }
    if (!headerDrawn) {
      let textX = LEFT;
      if (d.logo) {
        try {
          doc.image(d.logo, LEFT, 36, { fit: [60, 60] });
          textX = LEFT + 74;
        } catch {
          textX = LEFT;
        }
      }
      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .text(clean(d.company?.nombre ?? 'NOMFLOW'), textX, 42, { width: RIGHT - textX });
      if (d.company)
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#444')
          .text(clean(`${d.company.sigla} - ${d.company.direccion}`), textX, doc.y, {
            width: RIGHT - textX,
          });
      if (d.logo) doc.y = Math.max(doc.y, 100);
    }
    doc.x = LEFT;
    doc.fillColor('#000').moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(13).text('CONSTANCIA DE SOLICITUD DE VACACIONES APROBADA');
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#444')
      .text(`Aprobada el ${dateTimeFmt.format(d.approvedAt)}`)
      .fillColor('#000')
      .moveDown(0.8);

    const row = (k: string, v: string) => {
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).text(k, LEFT, y, { width: 190 });
      doc
        .font('Helvetica')
        .fontSize(10)
        .text(v, LEFT + 195, y, { width: RIGHT - LEFT - 195 });
      doc.moveDown(0.25);
    };
    doc.font('Helvetica-Bold').fontSize(11).text('Empleado').moveDown(0.3);
    row('Nombre', clean(d.employee.name) || '-');
    row('Identificación', clean(d.employee.nIde));
    row('Contrato', clean(d.employee.nCont));
    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').fontSize(11).text('Disfrute aprobado').moveDown(0.3);
    row('Inicio del disfrute', day(d.start));
    row('Último día hábil de disfrute', day(d.end));
    row('Días hábiles aprobados (se descuentan)', String(d.businessDays));
    row('Diferencia en días calendario (fin - inicio)', String(d.calendarDiff));
    row('Fecha de retorno', day(d.returnDate));
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555')
      .text(
        'Los días descontados de lo disponible son los días hábiles; la diferencia en días calendario cuenta también sábados, domingos y festivos y no se descuenta.',
        LEFT,
        doc.y,
        { width: RIGHT - LEFT },
      )
      .fillColor('#000')
      .moveDown(0.6);

    doc.font('Helvetica-Bold').fontSize(11).text('Períodos aplicados', LEFT).moveDown(0.3);
    for (const a of d.allocations)
      row(
        `${day(a.perIni)} a ${day(a.perFin)}`,
        `${a.days} ${a.days === 1 ? 'día hábil' : 'días hábiles'}`,
      );
    doc.moveDown(0.6);

    doc.font('Helvetica-Bold').fontSize(11).text('Trámite', LEFT).moveDown(0.3);
    for (const a of d.actions) {
      const y = doc.y;
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(
          `${a.label}${d.actions.some((x) => x.revision !== a.revision) ? ` (revisión ${a.revision})` : ''}`,
          LEFT,
          y,
          { width: 215 },
        );
      doc
        .font('Helvetica')
        .fontSize(9)
        .text(
          `${clean(a.name)}, ${dateTimeFmt.format(a.at)}${a.comment ? `. Motivo: ${clean(a.comment)}` : ''}`,
          LEFT + 220,
          y,
          {
            width: RIGHT - LEFT - 220,
          },
        );
      doc.moveDown(0.3);
    }
    doc.moveDown(0.8);

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555')
      .text(`Solicitud ${d.requestId}, revisión ${d.revision}.`, LEFT)
      .text(`Huella de la revisión aprobada (SHA-256): ${d.contentHash}`)
      .moveDown(0.3)
      .text(
        'Constancia generada por NOMFLOW a partir de las acciones registradas por cada persona autenticada. La huella y los registros son evidencia del trámite; no equivalen a una firma digital criptográfica.',
        { width: RIGHT - LEFT },
      );
    const footer = d.letterhead?.footer ?? null;
    if (footer) {
      doc.page.margins.bottom = 0;
      try {
        doc.image(footer.data, 0, PAGE_H - footer.heightPt, { width: PAGE_W });
      } catch {
        // imagen ilegible: se entrega sin pie
      }
    }
    doc.end();
  });
}
