import PDFDocument from 'pdfkit';
import { ceilToInteger } from './decimal';
import { pesosInWords } from './number-words';

export type VoucherMode = 'SIN_AJUSTE' | 'ENTERO_SUPERIOR';

export interface VoucherLine {
  cCon: string;
  concepto: string;
  unit: string | null;
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
  logo: Buffer | null;
  lines: VoucherLine[];
}

const MONTHS = [
  'ENERO',
  'FEBRERO',
  'MARZO',
  'ABRIL',
  'MAYO',
  'JUNIO',
  'JULIO',
  'AGOSTO',
  'SEPTIEMBRE',
  'OCTUBRE',
  'NOVIEMBRE',
  'DICIEMBRE',
];

/** «PAGO DE NOMINA: PRIMERA QUINCENA DE SEPTIEMBRE 2026», como en el comprobante modelo. */
export function periodBanner(per: string, nLiq: number): string {
  const month = MONTHS[Number(per.slice(4)) - 1] ?? per.slice(4);
  const what =
    nLiq === 1 ? 'PRIMERA QUINCENA' : nLiq === 2 ? 'SEGUNDA QUINCENA' : `LIQUIDACION ${nLiq}`;
  return `PAGO DE NOMINA: ${what} DE ${month} ${per.slice(0, 4)}`;
}

const clean = (v: string) =>
  Array.from(v, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : ch;
  })
    .join('')
    .trim();

function stamp(now: Date): string {
  const p = new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Bogota',
  }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}`;
}

const SCALE = 1_000_000n;

/** «$4,371,100.00»: miles con coma y decimales con punto, como en el comprobante modelo. */
function pesos(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative && abs !== 0n ? '-' : ''}$${whole}.${frac}`;
}

/** Cantidad del concepto (columna «Hrs»): entero con miles y decimales solo si los tiene. */
function quantity(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative && abs !== 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const PAGE_W = 612;
const PAGE_H = 792;
const X0 = 40;
const W = PAGE_W - 2 * X0;
const BORDER = '#555555';
const HEAD_GREY = '#777777';
const FS = 9;

// Ancho de las ocho columnas: Cod | Concepto | Hrs | Devengos || Cod | Concepto | Hrs | Deducidos
const C = [32, 100, 38, 70, 32, 136, 38, 86];
const COL_X = C.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? X0) + w], [X0]);

/**
 * Comprobante de pago con el diseño del modelo entregado por Gestión Humana (carta): encabezado con
 * logo y razón social, período, empleado, devengos a la izquierda y deducidos a la derecha, totales,
 * neto en cifras y letras, fecha de generación, observaciones y firma. Debajo del recuadro van los
 * datos de control del sistema: contrato, modo de presentación, versión y huella de la nómina.
 */
export function renderVoucherPdf(
  data: VoucherData,
  mode: VoucherMode,
  totals: { totalDev: bigint; totalDed: bigint; net: bigint },
  now: Date,
  options: { compress?: boolean } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: X0,
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

    const adjust = (v: bigint) => (mode === 'ENTERO_SUPERIOR' ? ceilToInteger(v) : v);
    const bottom = PAGE_H - 60;
    let y = 46;

    const box = (x: number, top: number, w: number, h: number) =>
      doc.lineWidth(0.8).rect(x, top, w, h).strokeColor(BORDER).stroke();
    const write = (
      text: string,
      x: number,
      top: number,
      w: number,
      o: {
        bold?: boolean;
        align?: 'left' | 'center' | 'right';
        size?: number;
        color?: string;
      } = {},
    ) => {
      doc
        .font(o.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(o.size ?? FS)
        .fillColor(o.color ?? '#000000')
        .text(text, x, top, { width: w, align: o.align ?? 'left', lineGap: 1 });
    };
    const heightOf = (text: string, w: number, size = FS, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      return doc.heightOfString(text, { width: w, lineGap: 1 });
    };

    const widthOf = (text: string, size = FS) => {
      doc.font('Helvetica').fontSize(size);
      return doc.widthOfString(text);
    };

    // Encabezado: logo | razón social y título
    const headH = 66;
    const logoW = 92;
    box(X0, y, logoW, headH);
    box(X0 + logoW, y, W - logoW, headH);
    if (data.logo) {
      try {
        doc.image(data.logo, X0 + 6, y + 6, {
          fit: [logoW - 12, headH - 12],
          align: 'center',
          valign: 'center',
        });
      } catch {
        // logo ilegible: se sigue sin él
      }
    }
    const name = clean(data.company?.nombre ?? 'NOMFLOW');
    const nameH = heightOf(name, W - logoW - 20, 14);
    write(name, X0 + logoW + 10, y + (headH - nameH - 16) / 2, W - logoW - 20, {
      size: 14,
      align: 'center',
    });
    write(
      'Comprobante de Pago',
      X0 + logoW + 10,
      y + (headH - nameH - 16) / 2 + nameH + 3,
      W - logoW - 20,
      {
        size: 12,
        align: 'center',
      },
    );
    y += headH + 3;

    // Período
    box(X0, y, W, 18);
    write(periodBanner(data.per, data.nLiq), X0, y + 5, W, {
      bold: true,
      align: 'center',
      color: HEAD_GREY,
    });
    y += 21;

    // Empleado
    const empW = [292, 110, W - 292 - 110];
    box(X0, y, empW[0] ?? 0, 20);
    box(X0 + (empW[0] ?? 0), y, empW[1] ?? 0, 20);
    box(X0 + (empW[0] ?? 0) + (empW[1] ?? 0), y, empW[2] ?? 0, 20);
    write(clean(data.employeeName) || '-', X0 + 5, y + 6, (empW[0] ?? 0) - 10, { bold: true });
    doc.font('Helvetica').fontSize(FS).fillColor('#000');
    const ccX = X0 + (empW[0] ?? 0) + 5;
    doc.text('CC No: ', ccX, y + 6, { continued: true, lineBreak: false });
    doc.font('Helvetica-Bold').text(clean(data.nIde), { lineBreak: false });
    const saX = X0 + (empW[0] ?? 0) + (empW[1] ?? 0) + 5;
    doc
      .font('Helvetica')
      .text('Salario Basico: ', saX, y + 6, { continued: true, lineBreak: false });
    doc
      .font('Helvetica-Bold')
      .text(data.salary === null ? '-' : pesos(adjust(data.salary)), { lineBreak: false });
    y += 23;

    // Encabezado de columnas (se repite en cada página)
    const columnHeader = () => {
      const labels = ['Cod', 'Concepto', 'Hrs', 'Devengos', 'Cod', 'Concepto', 'Hrs', 'Deducidos'];
      labels.forEach((l, i) => {
        box(COL_X[i] ?? X0, y, C[i] ?? 0, 15);
        write(l, (COL_X[i] ?? X0) + 2, y + 4, (C[i] ?? 0) - 4, {
          bold: true,
          align: 'center',
          color: HEAD_GREY,
        });
      });
      y += 15;
    };
    columnHeader();

    // Devengos a la izquierda y deducidos a la derecha, cada lista en su orden de origen
    const left = data.lines.filter((l) => l.dev !== null || l.ded === null);
    const right = data.lines.filter((l) => l.ded !== null);
    const rows = Math.max(left.length, right.length, 1);
    for (let i = 0; i < rows; i++) {
      const a = left[i];
      const b = right[i];
      const cellA = a && {
        code: clean(a.cCon),
        name: clean(a.concepto),
        qty: a.cant === null ? '' : quantity(a.cant),
        amount: a.dev === null ? '' : pesos(adjust(a.dev)),
      };
      const cellB = b && {
        code: clean(b.cCon),
        name: clean(b.concepto),
        qty: b.cant === null ? '' : quantity(b.cant),
        amount: b.ded === null ? '' : pesos(adjust(b.ded)),
      };
      const h = Math.max(
        15,
        cellA ? heightOf(cellA.name, (C[1] ?? 0) - 6) + 6 : 0,
        cellB ? heightOf(cellB.name, (C[5] ?? 0) - 6) + 6 : 0,
      );
      if (y + h > bottom - 120) {
        doc.addPage();
        y = 46;
        columnHeader();
      }
      for (let k = 0; k < 8; k++) box(COL_X[k] ?? X0, y, C[k] ?? 0, h);
      const put = (cell: typeof cellA, base: number) => {
        const fill = '-*-';
        const t = y + 4;
        const x = (k: number) => (COL_X[base + k] ?? X0) + 3;
        const w = (k: number) => (C[base + k] ?? 0) - 6;
        write(cell ? cell.code : fill, x(0), t, w(0));
        write(cell ? cell.name : fill, x(1), t, w(1));
        // la cantidad nunca se parte en dos líneas: si no cabe, baja de tamaño
        const qtySize = cell && widthOf(cell.qty) > w(2) ? 7 : FS;
        write(cell ? cell.qty : fill, x(2), t + (qtySize < FS ? 1 : 0), w(2) + 2, {
          align: cell ? 'right' : 'left',
          size: qtySize,
        });
        write(cell ? cell.amount : fill, x(3), t, w(3), { align: 'right' });
      };
      put(cellA, 0);
      put(cellB, 4);
      y += h;
    }

    // Totales, neto, observaciones y firma (se mantienen juntos)
    if (y + 118 > PAGE_H - 30) {
      doc.addPage();
      y = 46;
    }
    const half = (C[0] ?? 0) + (C[1] ?? 0) + (C[2] ?? 0) + (C[3] ?? 0);
    box(X0, y, half, 17);
    box(X0 + half, y, W - half, 17);
    write('TOTAL DEVENGOS', X0 + 4, y + 5, 110);
    write(pesos(totals.totalDev), X0 + half - 4 - 100, y + 5, 100, { align: 'right' });
    write('TOTAL DEDUCIDOS', X0 + half + 4, y + 5, 120);
    write(pesos(totals.totalDed), X0 + W - 4 - 100, y + 5, 100, { align: 'right' });
    y += 20;

    const netW = 170;
    const genW = 110;
    const wordsW = W - netW - genW;
    box(X0, y, netW, 30);
    box(X0 + netW, y, wordsW, 30);
    box(X0 + netW + wordsW, y, genW, 30);
    write(`NETO A PAGAR: ${pesos(totals.net)}`, X0 + 4, y + 10, netW - 8, { bold: true });
    const words = pesosInWords(totals.net);
    write(words, X0 + netW + 5, y + (30 - heightOf(words, wordsW - 10)) / 2, wordsW - 10, {
      align: 'center',
    });
    write('Generado en:', X0 + netW + wordsW + 4, y + 5, genW - 8);
    write(stamp(now), X0 + netW + wordsW + 4, y + 16, genW - 8);
    y += 33;

    const signW = 150;
    box(X0, y, W - signW, 34);
    box(X0 + W - signW, y, signW, 34);
    doc.font('Helvetica-Bold').fontSize(FS).fillColor('#000');
    doc.text('OBSERVACIONES: ', X0 + 4, y + 5, {
      width: W - signW - 8,
      continued: true,
      lineGap: 1,
    });
    doc
      .font('Helvetica')
      .text('El trabajador autoriza expresamente los descuentos incluidos en este comprobante', {
        lineGap: 1,
      });
    write('FIRMA:', X0 + W - signW + 4, y + 5, signW - 8);
    y += 42;

    // Datos de control del sistema (fuera del modelo): contrato, modo, versión y huella
    const FULL = W;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#333');
    doc.text('Contrato: ', X0, y, { width: FULL, continued: true });
    doc.font('Helvetica').text(clean(data.contrato));
    doc
      .font('Helvetica-Bold')
      .text('Modo de presentación: ', X0, doc.y, { width: FULL, continued: true });
    doc
      .font('Helvetica')
      .text(
        mode === 'SIN_AJUSTE'
          ? 'SIN AJUSTE (importes originales de la liquidación).'
          : 'ENTERO SUPERIOR. Cada devengado, deducido y salario se aproxima al entero superior y los totales suman los valores mostrados. El ajuste es solo de presentación y no modifica la liquidación pagada; para conciliación oficial se usan los importes originales.',
      );
    doc
      .fillColor('#555')
      .text(
        `Versión de nómina: v${data.version} - huella ${data.contentHash.slice(0, 12)}. Generado por NOMFLOW el ${stamp(now)} (no corresponde a la fecha de pago).`,
        X0,
        doc.y + 2,
        { width: FULL },
      );
    doc.end();
  });
}
