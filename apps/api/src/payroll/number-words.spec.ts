import { describe, expect, it } from 'vitest';
import { integerToWords, pesosInWords } from './number-words';

const S = 1_000_000n;

describe('cantidad en letras', () => {
  it('escribe los enteros como en un comprobante de pago', () => {
    const cases: [bigint, string][] = [
      [0n, 'CERO'],
      [1n, 'UN'],
      [15n, 'QUINCE'],
      [21n, 'VEINTIUN'],
      [31n, 'TREINTA Y UN'],
      [100n, 'CIEN'],
      [101n, 'CIENTO UN'],
      [1000n, 'MIL'],
      [1001n, 'MIL UN'],
      [21000n, 'VEINTIUN MIL'],
      [100000n, 'CIEN MIL'],
      [999999n, 'NOVECIENTOS NOVENTA Y NUEVE MIL NOVECIENTOS NOVENTA Y NUEVE'],
      [1000000n, 'UN MILLON DE'],
      [2000000n, 'DOS MILLONES DE'],
      [1500000n, 'UN MILLON QUINIENTOS MIL'],
      [1724504n, 'UN MILLON SETECIENTOS VEINTICUATRO MIL QUINIENTOS CUATRO'],
      [1000000000n, 'MIL MILLONES DE'],
      [1000000000000n, 'UN BILLON DE'],
    ];
    for (const [n, words] of cases) expect(integerToWords(n), String(n)).toBe(words);
  });

  it('cierra con PESOS M/L y agrega los centavos solo si los hay', () => {
    expect(pesosInWords(1_724_504n * S)).toBe(
      'UN MILLON SETECIENTOS VEINTICUATRO MIL QUINIENTOS CUATRO PESOS M/L',
    );
    expect(pesosInWords(S)).toBe('UN PESO M/L');
    expect(pesosInWords(0n)).toBe('CERO PESOS M/L');
    expect(pesosInWords(2_000_000n * S)).toBe('DOS MILLONES DE PESOS M/L');
    expect(pesosInWords(1_399n * S + 400_000n)).toBe(
      'MIL TRESCIENTOS NOVENTA Y NUEVE PESOS CON 40/100 M/L',
    );
    expect(pesosInWords(-150n * S)).toBe('MENOS CIENTO CINCUENTA PESOS M/L');
  });
});
