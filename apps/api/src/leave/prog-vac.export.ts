import ExcelJS from 'exceljs';

export interface ExportRow {
  nIde: string;
  nombre: string | null;
  nCont: string;
  perIni: string;
  perFin: string;
  dias: number;
  disp: number;
  estado: string;
  source: string;
  version: number;
}

const ESTADO_LABEL: Record<string, string> = {
  ACTIVA: 'Activa',
  VENCIDA: 'Vencida',
  LIQUIDADA: 'Liquidada',
};

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'Manual',
  IMPORT: 'Excel',
  AUTOMATICO: 'Automática',
};

/** El mismo resultado filtrado que ve el administrador, como Excel para revisión o archivo externo. */
export async function periodsWorkbook(rows: ExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NOMFLOW';
  wb.created = new Date();
  const ws = wb.addWorksheet('PROG_VAC');
  ws.columns = [
    { header: 'N_IDE', key: 'nIde', width: 16 },
    { header: 'Nombre', key: 'nombre', width: 32 },
    { header: 'N_CONT', key: 'nCont', width: 10 },
    { header: 'Período inicio', key: 'perIni', width: 16 },
    { header: 'Período fin', key: 'perFin', width: 16 },
    { header: 'Días', key: 'dias', width: 8 },
    { header: 'Disponibles', key: 'disp', width: 12 },
    { header: 'Estado', key: 'estado', width: 12 },
    { header: 'Origen', key: 'source', width: 12 },
    { header: 'Versión', key: 'version', width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  // N_IDE y N_CONT como texto, para no perder ceros iniciales al abrir en Excel.
  ws.getColumn('nIde').numFmt = '@';
  ws.getColumn('nCont').numFmt = '@';
  for (const r of rows) {
    ws.addRow({
      nIde: r.nIde,
      nombre: r.nombre ?? '',
      nCont: r.nCont,
      perIni: r.perIni,
      perFin: r.perFin,
      dias: r.dias,
      disp: r.disp,
      estado: ESTADO_LABEL[r.estado] ?? r.estado,
      source: SOURCE_LABEL[r.source] ?? r.source,
      version: r.version,
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
