export interface Allocation {
  progVacId: string;
  days: number;
  perIni?: string;
  perFin?: string;
}

export interface RequestRow {
  id: string;
  status: string;
  employee?: string;
  nIde: string;
  revision: number;
  start: string | null;
  end: string | null;
  calendarDiff: number | null;
  businessDays: number | null;
  returnDate: string | null;
  updatedAt: string;
}

export interface Revision {
  number: number;
  start: string;
  end: string;
  calendarDiff: number;
  businessDays: number;
  returnDate: string;
  reason: string | null;
  allocations: Allocation[];
}

export interface RequestDetail extends RequestRow {
  isOwner: boolean;
  isManager: boolean;
  revisions: Revision[];
  actions: {
    revisionNumber: number;
    action: string;
    comment: string | null;
    at: string;
    byMe: boolean;
  }[];
}

export const STATUS_LABEL: Record<string, string> = {
  PENDIENTE_JEFE: 'Pendiente del jefe de área',
  REVISION_EMPLEADO: 'Cambio propuesto: espera su aceptación',
  PENDIENTE_FINAL: 'Pendiente de la aprobación final',
  APROBADA: 'Aprobada',
  RECHAZADA: 'Rechazada',
  CANCELADA: 'Cancelada',
};

export const ACTION_LABEL: Record<string, string> = {
  ENVIAR: 'Solicitud enviada y fechas aceptadas por el empleado',
  ACEPTAR: 'Cambio propuesto aceptado por el empleado',
  PROPONER: 'Cambio propuesto por el jefe de área',
  APROBAR_JEFE: 'Aprobada por el jefe de área',
  APROBAR_FINAL: 'Aprobación final',
  RECHAZAR: 'Rechazada',
  CANCELAR: 'Cancelada por el empleado',
};

export const OPEN = ['PENDIENTE_JEFE', 'REVISION_EMPLEADO', 'PENDIENTE_FINAL'];

const fmt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });
export const longDate = (iso: string | null): string =>
  iso ? fmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : '—';

/** Mensaje claro para los códigos de error del API de vacaciones. */
export function vacationError(status: number, data: unknown): string {
  const d = (data ?? {}) as { code?: string; years?: number[] };
  if (status === 0) return 'No se pudo conectar con el servidor. Intente de nuevo.';
  switch (d.code) {
    case 'HOLIDAY_CALENDAR_MISSING':
      return `Aún no está publicado el calendario de festivos de ${(d.years ?? []).join(' y ')}. Gestión Humana debe publicarlo para poder calcular las fechas.`;
    case 'START_NOT_BUSINESS_DAY':
      return 'La fecha inicial debe ser un día hábil (lunes a viernes que no sea festivo).';
    case 'PERIOD_NOT_AVAILABLE':
      return 'Uno de los períodos ya no tiene días disponibles. Solo puede pedir de los períodos que aparecen en la lista.';
    case 'EXCEEDS_DISP':
      return 'Eligió más días de los disponibles en un período.';
    case 'INVALID_DAYS':
      return 'Indique al menos un día por período elegido.';
    case 'INVALID_DATE':
      return 'La fecha no es válida.';
    case 'NO_MANAGER':
      return 'Su área no tiene un jefe vigente asignado, por lo que no se puede enviar la solicitud. Avise a Gestión Humana.';
    case 'OVERLAP':
      return 'Las fechas se cruzan con otra solicitud suya vigente o aprobada.';
    case 'INVALID_STATE':
      return 'La solicitud cambió de estado. Actualice la página.';
    case 'CALENDAR_CHANGED':
      return 'El calendario de festivos cambió después de la aprobación del jefe. Rechace o devuelva la solicitud para recalcularla.';
    case 'INSUFFICIENT_DISP':
      return 'El período ya no tiene los días disponibles necesarios.';
    case 'REASON_REQUIRED':
      return 'Escriba el motivo (mínimo 10 caracteres).';
    case 'SELF_APPROVAL':
      return 'No puede aprobar su propia solicitud.';
    case 'FORBIDDEN':
      return 'No tiene el rol vigente para esta acción.';
    default:
      if (status === 403) return 'Se canceló la confirmación de identidad.';
      if (status === 404) return 'No se encontró la solicitud.';
      return 'No se pudo completar la acción. Intente de nuevo.';
  }
}
