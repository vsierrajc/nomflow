const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);
const DECIMAL_RE = /^-?\d{1,12}(\.\d{1,6})?$/;

export function isDecimalText(input: string): boolean {
  return DECIMAL_RE.test(input);
}

export function parseDecimal(input: string): bigint {
  if (!DECIMAL_RE.test(input)) throw new Error('decimal inválido');
  const negative = input.startsWith('-');
  const [whole = '0', frac = ''] = input.replace('-', '').split('.');
  const scaled = BigInt(whole) * FACTOR + BigInt(frac.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

export function toDecimalString(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${negative && abs !== 0n ? '-' : ''}${whole}.${frac}`;
}

export function ceilToInteger(value: bigint): bigint {
  const rest = value % FACTOR;
  if (rest === 0n) return value;
  return value > 0n ? value - rest + FACTOR : value - rest;
}

export function formatEsCo(value: bigint, minDecimals = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / FACTOR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  let frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  frac = frac.padEnd(minDecimals, '0');
  const body = frac.length > 0 ? `${whole},${frac}` : whole;
  return negative && abs !== 0n ? `-${body}` : body;
}

export const ZERO = 0n;
