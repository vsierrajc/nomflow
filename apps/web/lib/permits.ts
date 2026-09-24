export interface PermitType {
  id: string;
  name: string;
  description: string | null;
  supportRequired: boolean;
  allowsHours: boolean;
  maxDays: number | null;
}

export interface PermitRow {
  id: string;
  status: string;
  employee: string;
  nIde: string;
  typeName: string;
  start: string;
  end: string;
  startTime: string | null;
  endTime: string | null;
  justification: string;
  updatedAt: string;
}

export interface PermitDetail extends PermitRow {
  isOwner: boolean;
  support: { fileName: string; contentType: string; sizeBytes: number } | null;
  actions: { action: string; comment: string | null; at: string; byMe: boolean }[];
}

export const PERMIT_STATUS: Record<string, string> = {
  PENDIENTE_JEFE: 'Pendiente del jefe de área',
  APROBADO: 'Aprobado',
  RECHAZADO: 'Rechazado',
  CANCELADO: 'Cancelado',
};

export const PERMIT_ACTION: Record<string, string> = {
  ENVIAR: 'Solicitud enviada',
  APROBAR: 'Aprobado por el jefe de área',
  RECHAZAR: 'Rechazado por el jefe de área',
  CANCELAR: 'Cancelado por el empleado',
};

/** Rango legible: una fecha, o desde-hasta, con horas si es un permiso por horas. */
export function permitWhen(
  r: Pick<PermitRow, 'start' | 'end' | 'startTime' | 'endTime'>,
  fmt: (iso: string | null) => string,
): string {
  const day = r.start === r.end ? fmt(r.start) : `${fmt(r.start)} a ${fmt(r.end)}`;
  return r.startTime && r.endTime ? `${day}, de ${r.startTime} a ${r.endTime}` : day;
}

export function permitError(status: number, data: unknown): string {
  const code = ((data ?? {}) as { code?: string }).code;
  if (status === 0) return 'No se pudo conectar con el servidor. Intente de nuevo.';
  if (status === 413) return 'El soporte pesa más de 2 MB.';
  switch (code) {
    case 'TYPE_NOT_AVAILABLE':
      return 'Ese tipo de permiso no está disponible.';
    case 'INVALID_DATES':
      return 'Revise las fechas: la final no puede ser anterior a la inicial.';
    case 'MAX_DAYS':
      return 'El permiso supera los días máximos de este tipo.';
    case 'INVALID_HOURS':
      return 'Revise las horas: el permiso por horas es de un solo día, con hora inicial y final, y la final posterior a la inicial.';
    case 'JUSTIFICATION':
      return 'Escriba la justificación (mínimo 10 caracteres).';
    case 'SUPPORT_REQUIRED':
      return 'Este tipo de permiso exige adjuntar un soporte.';
    case 'INVALID_SUPPORT':
      return 'El soporte debe ser un PDF, PNG o JPEG de hasta 2 MB.';
    case 'OVERLAP':
      return 'Las fechas se cruzan con otro permiso suyo o con unas vacaciones aprobadas.';
    case 'NO_MANAGER':
      return 'Su área no tiene un jefe vigente asignado, por lo que no se puede enviar. Avise a Gestión Humana.';
    case 'INVALID_STATE':
      return 'La solicitud cambió de estado. Actualice la página.';
    case 'REASON_REQUIRED':
      return 'Escriba el motivo (mínimo 10 caracteres).';
    case 'SELF_APPROVAL':
      return 'No puede aprobar su propia solicitud.';
    case 'EXISTS':
      return 'Ya existe un tipo con ese código.';
    case 'VERSION_CONFLICT':
      return 'Otra persona modificó este tipo. Actualice la página e intente de nuevo.';
    case 'INVALID_TYPE':
      return 'Revise el código (mayúsculas, números y guion bajo), el nombre y el máximo de días.';
    default:
      if (status === 403)
        return 'Se canceló la confirmación de identidad o no tiene el rol vigente.';
      if (status === 404) return 'No se encontró la solicitud.';
      return 'No se pudo completar la acción. Intente de nuevo.';
  }
}
