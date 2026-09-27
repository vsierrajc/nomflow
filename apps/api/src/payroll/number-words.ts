const UNITS = [
  'CERO',
  'UN',
  'DOS',
  'TRES',
  'CUATRO',
  'CINCO',
  'SEIS',
  'SIETE',
  'OCHO',
  'NUEVE',
  'DIEZ',
  'ONCE',
  'DOCE',
  'TRECE',
  'CATORCE',
  'QUINCE',
  'DIECISEIS',
  'DIECISIETE',
  'DIECIOCHO',
  'DIECINUEVE',
  'VEINTE',
  'VEINTIUN',
  'VEINTIDOS',
  'VEINTITRES',
  'VEINTICUATRO',
  'VEINTICINCO',
  'VEINTISEIS',
  'VEINTISIETE',
  'VEINTIOCHO',
  'VEINTINUEVE',
];
const TENS = [
  '',
  '',
  '',
  'TREINTA',
  'CUARENTA',
  'CINCUENTA',
  'SESENTA',
  'SETENTA',
  'OCHENTA',
  'NOVENTA',
];
const HUNDREDS = [
  '',
  'CIENTO',
  'DOSCIENTOS',
  'TRESCIENTOS',
  'CUATROCIENTOS',
  'QUINIENTOS',
  'SEISCIENTOS',
  'SETECIENTOS',
  'OCHOCIENTOS',
  'NOVECIENTOS',
];

/** 0..999 con «UN» apocopado (va siempre antes de un sustantivo: UN MIL, UN MILLON, UN PESO). */
function below1000(n: number): string {
  if (n === 100) return 'CIEN';
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(HUNDREDS[h] ?? '');
  if (r > 0) {
    if (r < 30) parts.push(UNITS[r] ?? '');
    else {
      const t = TENS[Math.floor(r / 10)] ?? '';
      const u = r % 10;
      parts.push(u === 0 ? t : `${t} Y ${UNITS[u] ?? ''}`);
    }
  }
  return parts.join(' ');
}

/** 1..999999 en palabras. */
function below1e6(n: number): string {
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (th > 0) parts.push(th === 1 ? 'MIL' : `${below1000(th)} MIL`);
  if (rest > 0) parts.push(below1000(rest));
  return parts.join(' ');
}

const SCALES = ['', 'MILLON', 'BILLON', 'TRILLON', 'CUATRILLON'];

/** Un entero no negativo en palabras, en mayúsculas y sin tildes, como en los comprobantes de pago. */
export function integerToWords(value: bigint): string {
  if (value < 0n) throw new Error('solo enteros no negativos');
  if (value === 0n) return 'CERO';
  const chunks: number[] = [];
  let rest = value;
  while (rest > 0n) {
    chunks.push(Number(rest % 1_000_000n));
    rest /= 1_000_000n;
  }
  const parts: string[] = [];
  for (let k = chunks.length - 1; k >= 0; k--) {
    const c = chunks[k] ?? 0;
    if (c === 0) continue;
    if (k === 0) {
      parts.push(below1e6(c));
      continue;
    }
    const name = SCALES[k] ?? 'MILLON';
    parts.push(c === 1 ? `UN ${name}` : `${below1e6(c)} ${name.replace('LLON', 'LLONES')}`);
    // exactamente millones (sin nada después): «DOS MILLONES DE PESOS»
    if (chunks.slice(0, k).every((x) => x === 0)) parts.push('DE');
  }
  return parts.join(' ');
}

/** «MIL QUINIENTOS PESOS M/L», con «CON NN/100» cuando hay centavos. `value` va escalado a 6 decimales. */
export function pesosInWords(value: bigint, scale = 1_000_000n): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const cents = ((abs % scale) * 100n) / scale;
  const noun = whole === 1n ? 'PESO' : 'PESOS';
  const words = `${integerToWords(whole)} ${noun}`;
  const withCents = cents > 0n ? `${words} CON ${cents.toString().padStart(2, '0')}/100` : words;
  return `${negative && abs !== 0n ? 'MENOS ' : ''}${withCents} M/L`;
}
