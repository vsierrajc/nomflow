import PDFDocument from 'pdfkit';

export interface LaborCertPdfData {
  /** Referencia corta para rastrear la emisión en el historial. */
  ref: string;
  title: string;
  /** Texto ya con las variables sustituidas; los párrafos se separan con una línea en blanco. */
  body: string;
  company: { nombre: string; sigla: string; direccion: string };
  logo: Buffer | null;
  /** Control del sistema de gestión de la calidad. */
  docCode: string;
  docVersion: string;
  docDate: string;
  signerName: string;
  signerTitle: string;
  footerLines: string[];
  issuedAt: Date;
  /** Marca de agua «VISTA PREVIA» para el ensayo del administrador. */
  preview?: boolean;
}

const LEFT = 56;
const RIGHT = 539;
const WIDTH = RIGHT - LEFT;
const stamp = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

/**
 * Certificado laboral: encabezado con logo y razón social, datos de control del formato, cuerpo
 * tomado de la plantilla y pie con los datos de la empresa. El mismo dato produce el mismo documento.
 */
export function renderLaborCertificatePdf(
  d: LaborCertPdfData,
  options: { compress?: boolean } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 40, left: LEFT, right: 595 - RIGHT },
      compress: options.compress ?? true,
      info: {
        Title: `${d.title} - ${d.company.nombre}`,
        Author: 'NOMFLOW',
        Producer: 'NOMFLOW',
        CreationDate: d.issuedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Encabezado: logo y razón social a la izquierda, control del documento a la derecha.
    let textX = LEFT;
    if (d.logo) {
      try {
        doc.image(d.logo, LEFT, 48, { fit: [64, 56] });
        textX = LEFT + 76;
      } catch {
        // logo ilegible: se sigue sin él
      }
    }
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111');
    doc.text(d.company.nombre, textX, 54, { width: 250 });
    doc.font('Helvetica').fontSize(9).fillColor('#444444');
    doc.text(d.company.direccion, textX, doc.y + 2, { width: 250 });

    const boxX = 372;
    doc
      .rect(boxX, 48, RIGHT - boxX, 56)
      .strokeColor('#888888')
      .lineWidth(0.6)
      .stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#111111');
    doc.text(`Código: ${d.docCode}`, boxX + 6, 54, { width: RIGHT - boxX - 12 });
    doc.font('Helvetica').fontSize(8);
    doc.text(`Versión: ${d.docVersion}`, boxX + 6, 68, { width: RIGHT - boxX - 12 });
    if (d.docDate) doc.text(`Fecha: ${d.docDate}`, boxX + 6, 80, { width: RIGHT - boxX - 12 });

    doc.moveTo(LEFT, 116).lineTo(RIGHT, 116).strokeColor('#222222').lineWidth(1).stroke();

    // Título y cuerpo.
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#111111');
    doc.text(d.title, LEFT, 150, { width: WIDTH, align: 'center' });
    doc.moveDown(1.6);
    doc.font('Helvetica').fontSize(11).fillColor('#111111');
    for (const para of d.body.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      const heading = p === p.toUpperCase() && p.length <= 60;
      doc.font(heading ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(p, LEFT, doc.y, { width: WIDTH, align: heading ? 'center' : 'justify', lineGap: 4 });
      doc.moveDown(1);
    }

    // Firma (solo si la empresa configuró quién firma).
    if (d.signerName) {
      doc.moveDown(3);
      const y = doc.y;
      doc
        .moveTo(LEFT, y)
        .lineTo(LEFT + 200, y)
        .strokeColor('#222222')
        .lineWidth(0.8)
        .stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(d.signerName, LEFT, y + 4, { width: 260 });
      if (d.signerTitle)
        doc.font('Helvetica').fontSize(9).text(d.signerTitle, LEFT, doc.y, { width: 260 });
    }

    // Pie: datos de la empresa y referencia. Se escribe dentro del margen inferior sin abrir otra página.
    doc.page.margins.bottom = 0;
    const footTop = 760;
    doc.moveTo(LEFT, footTop).lineTo(RIGHT, footTop).strokeColor('#888888').lineWidth(0.6).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333');
    doc.text(d.company.nombre, LEFT, footTop + 5, {
      width: WIDTH,
      align: 'center',
      lineBreak: false,
    });
    doc.font('Helvetica').fontSize(7.5).fillColor('#555555');
    let y = footTop + 16;
    for (const line of [d.company.direccion, ...d.footerLines].filter(Boolean).slice(0, 4)) {
      doc.text(line, LEFT, y, { width: WIDTH, align: 'center', lineBreak: false });
      y += 9;
    }
    doc.fontSize(6.5).fillColor('#777777');
    doc.text(`Ref. ${d.ref} - Generado por NOMFLOW el ${stamp.format(d.issuedAt)}`, LEFT, 824, {
      width: WIDTH,
      align: 'center',
      lineBreak: false,
    });

    if (d.preview) {
      doc.save();
      doc.rotate(-35, { origin: [300, 420] });
      doc.font('Helvetica-Bold').fontSize(64).fillColor('#dddddd').opacity(0.5);
      doc.text('VISTA PREVIA', 90, 400, { lineBreak: false });
      doc.restore();
    }
    doc.end();
  });
}
