import { describe, expect, it } from 'vitest';
import { ceilToInteger, formatEsCo, isDecimalText, parseDecimal, toDecimalString } from './decimal';

describe('decimal exacto', () => {
  it('convierte sin perder precisión, incluso donde un double falla', () => {
    expect(toDecimalString(parseDecimal('1500000.5'))).toBe('1500000.500000');
    expect(toDecimalString(parseDecimal('0.1') + parseDecimal('0.2'))).toBe('0.300000');
    expect(toDecimalString(parseDecimal('123456789012.123456'))).toBe('123456789012.123456');
    expect(toDecimalString(parseDecimal('-0.000001'))).toBe('-0.000001');
    expect(toDecimalString(0n)).toBe('0.000000');
  });

  it('rechaza formatos ambiguos o fuera de NUMBER(18,6)', () => {
    for (const bad of ['1e5', '1,5', '1.2345678', '', 'abc', '--1', '1234567890123', '.5', '5.']) {
      expect(isDecimalText(bad), bad).toBe(false);
    }
    expect(() => parseDecimal('1e5')).toThrow();
  });

  it('ceil matemático: hacia arriba, y hacia cero en negativos', () => {
    const c = (s: string) => toDecimalString(ceilToInteger(parseDecimal(s)));
    expect(c('1.2')).toBe('2.000000');
    expect(c('1.000000')).toBe('1.000000');
    expect(c('0.000001')).toBe('1.000000');
    expect(c('-1.2')).toBe('-1.000000');
    expect(c('-0.5')).toBe('0.000000');
    expect(c('-2')).toBe('-2.000000');
  });

  it('formatea en es-CO con al menos 2 decimales y hasta 6', () => {
    expect(formatEsCo(parseDecimal('1500000.5'))).toBe('1.500.000,50');
    expect(formatEsCo(parseDecimal('1234.123456'))).toBe('1.234,123456');
    expect(formatEsCo(parseDecimal('-1234567'))).toBe('-1.234.567,00');
    expect(formatEsCo(parseDecimal('999'))).toBe('999,00');
    expect(formatEsCo(0n)).toBe('0,00');
    expect(formatEsCo(parseDecimal('2000000'), 0)).toBe('2.000.000');
  });
});
