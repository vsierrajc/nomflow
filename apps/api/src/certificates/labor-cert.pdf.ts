import PDFDocument from 'pdfkit';
import type { Letterhead } from '../org/letterhead.service';
import { addSignaturePlaceholder } from './digital-signature';

export interface LaborCertPdfData {
  /** Referencia corta para rastrear la emisión en el historial. */
  ref: string;
  title: string;
  /** Texto ya con las variables sustituidas; los párrafos se separan con una línea en blanco. */
  body: string;
  company: { nombre: string; sigla: string; direccion: string };
  logo: Buffer | null;
  /** Imágenes a todo el ancho de la página; si faltan se usa el encabezado y pie de texto. */
  letterhead?: { header: Letterhead | null; footer: Letterhead | null };
  /** Control del sistema de gestión de la calidad. */
  docCode: string;
  docVersion: string;
  docDate: string;
  /** Quien firma: nombre, cargo y la imagen de su firma (solo en emisiones reales). */
  signer: { name: string; title: string; signature: Buffer | null } | null;
  footerLines: string[];
  issuedAt: Date;
  /** Si se firma digitalmente, el PDF lleva un espacio reservado para la firma criptográfica. */
  digital?: { reason: string; name: string; location: string; contact: string } | undefined;
  /** Marca de agua «VISTA PREVIA» para el ensayo del administrador. */
  preview?: boolean;
}

const LEFT = 56;
const PAGE_W = 612;
const PAGE_H = 792;
const RIGHT = PAGE_W - 56;
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
      size: 'LETTER',
      margins: { top: 48, bottom: 40, left: LEFT, right: PAGE_W - RIGHT },
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

    const header = d.letterhead?.header ?? null;
    const footerImg = d.letterhead?.footer ?? null;
    const boxTop = 48;
    // Ancho ajustado al texto más largo, en vez de un rótulo fijo que sobra de espacio.
    const boxLines = [`Código: ${d.docCode}`, `Versión: ${d.docVersion}`];
    if (d.docDate) boxLines.push(`Fecha: ${d.docDate}`);
    doc.font('Helvetica-Bold').fontSize(8);
    const boxTextW = Math.max(...boxLines.map((l) => doc.widthOfString(l)));
    const boxPad = 10;
    const boxW = Math.min(boxTextW + boxPad * 2 + 5, RIGHT - LEFT);
    const lineH = 11.5;
    const boxH = boxLines.length * lineH + 9;
    let ruleY = boxTop + boxH + 6;
    let usedImage = false;
    // Con encabezado en imagen (el logo suele ir a la derecha, como en el membrete de GRALCO) el
    // recuadro va a la izquierda, a la misma altura, para no superponerse a nada del membrete.
    let boxX = LEFT;
    if (header) {
      try {
        doc.image(header.data, 0, 0, { width: PAGE_W });
        usedImage = true;
        ruleY = Math.max(header.heightPt, boxTop + boxH) + 6;
      } catch {
        // imagen ilegible: se usa el encabezado de texto
      }
    }
    if (!usedImage) boxX = RIGHT - boxW; // sin imagen: logo y razón social a la izquierda, caja a la derecha
    if (!usedImage) {
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
    }

    // Recuadro de control del documento: ajustado al texto y translúcido, para que se superponga al
    // encabezado (imagen o logo) como una transparencia y no lo tape.
    doc.save();
    doc.fillOpacity(0.82);
    doc.roundedRect(boxX, boxTop, boxW, boxH, 3).fillAndStroke('#f4f7fb', '#c3ccd6');
    doc.roundedRect(boxX, boxTop, 4, boxH, 2).fill('#0b5cad');
    doc.restore();
    boxLines.forEach((line, i) => {
      doc
        .font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8)
        .fillColor(i === 0 ? '#0b3d6b' : '#333333');
      doc.text(line, boxX + 11, boxTop + 6 + i * lineH, { width: boxW - 16, lineBreak: false });
    });
    doc.fillColor('#111111');

    doc.moveTo(LEFT, ruleY).lineTo(RIGHT, ruleY).strokeColor('#222222').lineWidth(1).stroke();

    // Título y cuerpo.
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#111111');
    doc.text(d.title, LEFT, ruleY + 34, { width: WIDTH, align: 'center' });
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

    // Firma: imagen de quien firma sobre su nombre y cargo.
    if (d.signer) {
      doc.moveDown(2);
      const y = doc.y;
      if (d.signer.signature) {
        try {
          doc.image(d.signer.signature, LEFT, y, { fit: [170, 60] });
        } catch {
          // imagen ilegible: se sigue con el nombre
        }
      } else if (d.preview) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(9)
          .fillColor('#888888')
          .text('(firma de ejemplo)', LEFT + 20, y + 22);
        doc.fillColor('#111111');
      }
      const lineY = y + 64;
      doc
        .moveTo(LEFT, lineY)
        .lineTo(LEFT + 200, lineY)
        .strokeColor('#222222')
        .lineWidth(0.8)
        .stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#111111')
        .text(d.signer.name, LEFT, lineY + 4, { width: 300 });
      doc.font('Helvetica').fontSize(9).text(d.signer.title, LEFT, doc.y, { width: 300 });
      if (d.digital)
        doc
          .font('Helvetica-Oblique')
          .fontSize(7.5)
          .fillColor('#555555')
          .text(
            'Documento firmado digitalmente. Verifique la firma en su lector de PDF.',
            LEFT,
            doc.y + 2,
            { width: 320 },
          );
    }

    // Pie: imagen a todo el ancho o, si no hay, datos de la empresa. Se escribe dentro del margen
    // inferior sin abrir otra página.
    doc.page.margins.bottom = 0;
    let footerDrawn = false;
    if (footerImg) {
      try {
        doc.image(footerImg.data, 0, PAGE_H - footerImg.heightPt, { width: PAGE_W });
        footerDrawn = true;
      } catch {
        // imagen ilegible: se usa el pie de texto
      }
    }
    const refY = footerDrawn && footerImg ? PAGE_H - footerImg.heightPt - 10 : PAGE_H - 18;
    if (!footerDrawn) {
      const footTop = PAGE_H - 82;
      doc
        .moveTo(LEFT, footTop)
        .lineTo(RIGHT, footTop)
        .strokeColor('#888888')
        .lineWidth(0.6)
        .stroke();
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
    }
    doc.font('Helvetica').fontSize(6.5).fillColor('#777777');
    doc.text(`Ref. ${d.ref} - Generado por NOMFLOW el ${stamp.format(d.issuedAt)}`, LEFT, refY, {
      width: WIDTH,
      align: 'center',
      lineBreak: false,
    });

    if (d.preview) {
      doc.save();
      doc.rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] });
      doc.font('Helvetica-Bold').fontSize(64).fillColor('#dddddd').opacity(0.5);
      doc.text('VISTA PREVIA', 100, 380, { lineBreak: false });
      doc.restore();
    }
    if (d.digital) addSignaturePlaceholder(doc, d.digital);
    doc.end();
  });
}
