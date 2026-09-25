import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  MissingDataError,
  extractVariables,
  formatCop,
  longDateEs,
  numberToSpanish,
  renderTemplate,
  salaryInWords,
  validateTemplate,
} from './template-engine';

describe('motor de plantillas', () => {
  it('extrae variables, sin repetir', () => {
    expect(extractVariables('{{NOMBRE}} y {{ N_IDE }} y {{NOMBRE}}')).toEqual(['NOMBRE', 'N_IDE']);
  });

  it('las plantillas por omisión son válidas', () => {
    expect(
      validateTemplate('GENERAL', DEFAULT_TEMPLATES.GENERAL.title, DEFAULT_TEMPLATES.GENERAL.body),
    ).toEqual([]);
    expect(
      validateTemplate(
        'DIRIGIDO',
        DEFAULT_TEMPLATES.DIRIGIDO.title,
        DEFAULT_TEMPLATES.DIRIGIDO.body,
      ),
    ).toEqual([]);
  });

  it('rechaza variables desconocidas, llaves sueltas y reglas de la modalidad', () => {
    expect(validateTemplate('GENERAL', 'T', 'Hola {{EXTRA}}').join(' ')).toContain('{{EXTRA}}');
    expect(validateTemplate('GENERAL', 'T', 'Hola {{NOMBRE}} {{').join(' ')).toContain('llaves');
    expect(validateTemplate('DIRIGIDO', 'T', 'Hola {{NOMBRE}}').join(' ')).toContain(
      '{{DESTINATARIO}}',
    );
    expect(validateTemplate('GENERAL', 'T', 'Para {{DESTINATARIO}}').join(' ')).toContain(
      'no puede incluir',
    );
    expect(validateTemplate('GENERAL', 'T', 'Gana {{S_ACT_LETRAS}}').join(' ')).toContain(
      'salario en letras',
    );
    expect(validateTemplate('GENERAL', '', 'x')).not.toEqual([]);
    expect(validateTemplate('GENERAL', 'T', 'x'.repeat(4001))).not.toEqual([]);
    // sin expresiones ni HTML: se ven como texto y no como variables
    expect(validateTemplate('GENERAL', 'T', '{{NOMBRE.constructor}}')).not.toEqual([]);
  });

  it('sustituye, limpia caracteres de control y no inyecta', () => {
    const out = renderTemplate('Hola {{NOMBRE}}, {{CARGO}}.', {
      NOMBRE: 'ANA\u0000 PÉREZ',
      CARGO: '<b>{{N_IDE}}</b>',
    });
    expect(out).toBe('Hola ANA PÉREZ, <b>{{N_IDE}}</b>.'); // el valor no se vuelve a interpretar
  });

  it('un dato ausente bloquea en lugar de dejar la variable visible', () => {
    expect(() => renderTemplate('{{NOMBRE}} {{CARGO}}', { NOMBRE: 'ANA', CARGO: null })).toThrow(
      MissingDataError,
    );
    try {
      renderTemplate('{{NOMBRE}} {{CARGO}} {{AREA}}', { NOMBRE: 'ANA', CARGO: '  ' });
    } catch (e) {
      expect((e as MissingDataError).fields).toEqual(['CARGO', 'AREA']);
    }
  });

  it('formatos de fecha, moneda y letras', () => {
    expect(longDateEs('2024-03-05')).toBe('5 de marzo de 2024');
    expect(formatCop('1500000.500000')).toContain('1.500.00');
    expect(numberToSpanish(0)).toBe('cero');
    expect(numberToSpanish(16)).toBe('dieciséis');
    expect(numberToSpanish(21)).toBe('veintiuno');
    expect(numberToSpanish(100)).toBe('cien');
    expect(numberToSpanish(101)).toBe('ciento uno');
    expect(numberToSpanish(1000)).toBe('mil');
    expect(numberToSpanish(21000)).toBe('veintiún mil');
    expect(numberToSpanish(1_500_000)).toBe('un millón quinientos mil');
    expect(numberToSpanish(2_350_000)).toBe('dos millones trescientos cincuenta mil');
    expect(numberToSpanish(1_300_000)).toBe('un millón trescientos mil');
    expect(numberToSpanish(45_678_901)).toBe(
      'cuarenta y cinco millones seiscientos setenta y ocho mil novecientos uno',
    );
    expect(salaryInWords('1423500.000000')).toBe(
      'un millón cuatrocientos veintitrés mil quinientos pesos m/cte',
    );
    expect(() => numberToSpanish(-1)).toThrow();
  });
});
