import { describe, it, expect } from 'vitest';
import { parseExpr, compileExpr } from './ConditionForm';

/** Ida y vuelta del builder visual: lo que se guarda debe volver a compilarse IGUAL, sin colapsar a «true». */
const roundTrip = (expr: string): string => {
  const { rules, combinator } = parseExpr(expr);
  return compileExpr(rules, combinator);
};

describe('ConditionForm — parseExpr/compileExpr (round-trip)', () => {
  it('conserva expresiones con clave compuesta «:» (salida de agente/nodo, M72)', () => {
    // Regresión: antes el builder no aceptaba «:» y al editar el nodo colapsaba la condición a «true»,
    // invirtiendo la lógica de la plantilla «Equipo QA» (la rama de fallo se disparaba SIEMPRE).
    expect(roundTrip('agent:qa.output ~ FALLA')).toBe('agent:qa.output ~ FALLA');
    expect(roundTrip('connector:c.status == 200')).toBe('connector:c.status == 200');
    const parsed = parseExpr('agent:qa.output ~ FALLA');
    expect(parsed.rules[0]).toEqual({ field: 'agent:qa.output', op: '~', value: 'FALLA' });
  });

  it('conserva las formas clásicas y los combinadores', () => {
    expect(roundTrip('ticket.summary ~ urgente')).toBe('ticket.summary ~ urgente');
    expect(roundTrip('variables.count > 5')).toBe('variables.count > 5');
    expect(roundTrip('variables.a == 1 && variables.b == 2')).toBe('variables.a == 1 && variables.b == 2');
    expect(roundTrip('variables.a == 1 || variables.b == 2')).toBe('variables.a == 1 || variables.b == 2');
  });

  it('«true»/vacío quedan como «true» (una regla en blanco)', () => {
    expect(roundTrip('true')).toBe('true');
    expect(roundTrip('')).toBe('true');
    expect(parseExpr('').rules).toEqual([{ field: '', op: '==', value: '' }]);
  });

  it('acepta operadores >=/<= y otras claves compuestas sin romper el ida y vuelta', () => {
    expect(roundTrip('foo:bar.baz >= 3.14')).toBe('foo:bar.baz >= 3.14');
    expect(parseExpr('agent:x.output ~ ok').rules[0]).toEqual({ field: 'agent:x.output', op: '~', value: 'ok' });
  });

  it('una regla a medias (campo sin valor) NO corrompe la expresión', () => {
    expect(compileExpr([{ field: 'ticket.summary', op: '==', value: '' }], '&&')).toBe('true');
    expect(compileExpr([{ field: '', op: '==', value: '' }], '&&')).toBe('true');
  });
});
