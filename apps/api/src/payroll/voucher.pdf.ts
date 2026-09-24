import PDFDocument from 'pdfkit';
import { ceilToInteger, formatEsCo } from './decimal';

export type VoucherMode = 'SIN_AJUSTE' | 'ENTERO_SUPERIOR';

export interface VoucherLine {
  cCon: string;
  concepto: string;
  cant: bigint | null;
  dev: bigint | null;
  ded: bigint | null;
}

export interface VoucherData {
  per: string;
  nLiq: number;
  contrato: string;
  nIde: string;
  employeeName: string;
  company: { nombre: string; sigla: string; direccion: string } | null;
  salary: bigint | null;
  version: number;
  contentHash: string;
  lines: VoucherLine[];
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export function periodLabel(per: string, nLiq: number): string {
  const month = MONTHS[Number(per.slice(4)) - 1] ?? per.slice(4);
  const quincena = nLiq === 1 ? 'primera quincena' : 'segunda quincena';
  return `${month} de ${per.slice(0, 4)} - ${quincena} (liquidación ${nLiq})`;
}

const clean = (v: string) =>
  Array.from(v, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : ch;
  })
    .join('')
    .trim();

function generatedAt(now: Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(now);
}

function fit(doc: PDFKit.PDFDocument, text: string, width: number): string {
  if (doc.widthOfString(text) <= width) return text;
  let out = text;
  while (out.length > 1 && doc.widthOfString(`${out}...`) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

const LEFT = 40;
const RIGHT = 555;
const COLS = { code: 40, name: 100, qty: 315, dev: 385, ded: 470 };

export function renderVoucherPdf(
  data: VoucherData,
  mode: VoucherMode,
  totals: { totalDev: bigint; totalDed: bigint; net: bigint },
  now: Date,
  options: { compress?: boolean } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      compress: options.compress ?? true,
      info: {
        Title: `Comprobante de pago ${data.per}-${data.nLiq}`,
        Author: 'NOMFLOW',
        Producer: 'NOMFLOW',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const adjust = (v: bigint | null) =>
      v === null ? null : mode === 'ENTERO_SUPERIOR' ? ceilToInteger(v) : v;
    const money = (v: bigint | null) =>
      v === null ? '' : formatEsCo(v, mode === 'ENTERO_SUPERIOR' ? 0 : 2);

    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(clean(data.company?.nombre ?? 'NOMFLOW'), LEFT, 40);
    if (data.company) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#444')
        .text(clean(`${data.company.sigla} - ${data.company.direccion}`));
    }
    doc.fillColor('#000').moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('COMPROBANTE DE PAGO (VOLANTE)');
    doc.font('Helvetica').fontSize(10).text(periodLabel(data.per, data.nLiq)).moveDown(0.6);

    const info: [string, string][] = [
      ['Nombre', clean(data.employeeName) || '-'],
      ['Identificación', clean(data.nIde)],
      ['Contrato', clean(data.contrato)],
      [
        'Salario (histórico de la liquidación)',
        data.salary === null ? '-' : money(adjust(data.salary)),
      ],
    ];
    for (const [k, v] of info) {
      doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(v);
    }
    doc.moveDown(0.8);

    const header = () => {
      const y = doc.y;
      doc
        .rect(LEFT, y - 2, RIGHT - LEFT, 16)
        .fill('#e8edf2')
        .fillColor('#000');
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Código', COLS.code + 2, y + 1, { width: 55 });
      doc.text('Concepto', COLS.name, y + 1, { width: 205 });
      doc.text('Cantidad', COLS.qty, y + 1, { width: 65, align: 'right' });
      doc.text('Devengado', COLS.dev, y + 1, { width: 75, align: 'right' });
      doc.text('Deducido', COLS.ded, y + 1, { width: 85, align: 'right' });
      doc.y = y + 18;
      doc.font('Helvetica').fontSize(9);
    };
    header();
    for (const line of data.lines) {
      if (doc.y > 720) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      doc.text(fit(doc, clean(line.cCon), 55), COLS.code + 2, y, { width: 58, lineBreak: false });
      doc.text(fit(doc, clean(line.concepto), 200), COLS.name, y, {
        width: 210,
        lineBreak: false,
      });
      doc.text(line.cant === null ? '' : formatEsCo(line.cant, 0), COLS.qty, y, {
        width: 65,
        align: 'right',
        lineBreak: false,
      });
      doc.text(money(adjust(line.dev)), COLS.dev, y, {
        width: 75,
        align: 'right',
        lineBreak: false,
      });
      doc.text(money(adjust(line.ded)), COLS.ded, y, {
        width: 85,
        align: 'right',
        lineBreak: false,
      });
      doc.y = y + 14;
    }

    if (doc.y > 690) doc.addPage();
    doc
      .moveTo(LEFT, doc.y + 2)
      .lineTo(RIGHT, doc.y + 2)
      .strokeColor('#999')
      .stroke()
      .strokeColor('#000');
    doc.y += 8;
    const totalRow = (label: string, dev: string, ded: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      doc.text(label, COLS.name, y, { width: 205, lineBreak: false });
      doc.text(dev, COLS.dev, y, { width: 75, align: 'right', lineBreak: false });
      doc.text(ded, COLS.ded, y, { width: 85, align: 'right', lineBreak: false });
      doc.y = y + 16;
    };
    const dec = mode === 'ENTERO_SUPERIOR' ? 0 : 2;
    totalRow('Totales', formatEsCo(totals.totalDev, dec), formatEsCo(totals.totalDed, dec));
    totalRow('Neto a pagar', formatEsCo(totals.net, dec), '', true);
    doc.x = LEFT;
    doc.moveDown(1);

    const FULL = { width: RIGHT - LEFT };
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .text('Modo de presentación: ', LEFT, doc.y, { continued: true, ...FULL })
      .font('Helvetica');
    if (mode === 'SIN_AJUSTE') {
      doc.text('SIN AJUSTE (importes originales de la liquidación).', FULL);
    } else {
      doc.text(
        'ENTERO SUPERIOR. Cada devengado, deducido y salario se aproxima al entero superior y los totales suman los valores mostrados. El ajuste es solo de presentación y no modifica la liquidación pagada; para conciliación oficial se usan los importes originales.',
        { width: RIGHT - LEFT },
      );
    }
    doc.moveDown(0.5).fontSize(8).fillColor('#444');
    doc.text(`Versión de nómina: v${data.version} - huella ${data.contentHash.slice(0, 12)}`);
    doc.text(
      `Fecha de generación de este documento: ${generatedAt(now)} (no corresponde a la fecha de pago).`,
    );
    doc.text('La cantidad se muestra sin unidad: su unidad depende del concepto.');
    doc.end();
  });
}
