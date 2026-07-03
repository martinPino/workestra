import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@core/contracts';
import { interpolate, hasTemplate } from './interpolate';

const ctx = (variables: Record<string, unknown>): ExecutionContext =>
  ({ variables, ticket: { title: 'Ticket X' }, repository: {} }) as unknown as ExecutionContext;

describe('interpolate (M12 · flujo de datos entre nodos)', () => {
  it('resuelve variables con claves de dos puntos y campos anidados', () => {
    const c = ctx({ 'agent:LLM': { output: 'Hola mundo' }, 'connector:c': { bodyPreview: 'abc' } });
    expect(interpolate('Dice: {{agent:LLM.output}}', c)).toBe('Dice: Hola mundo');
    expect(interpolate('{{connector:c.bodyPreview}}', c)).toBe('abc');
  });

  it('accede a ticket y variables por la raíz', () => {
    const c = ctx({ task: 'analizar' });
    expect(interpolate('{{ticket.title}} / {{task}}', c)).toBe('Ticket X / analizar');
  });

  it('placeholder inexistente → cadena vacía (no rompe)', () => {
    expect(interpolate('x={{no.existe}}', ctx({}))).toBe('x=');
  });

  it('jsonSafe escapa comillas/nueva línea para incrustar en JSON válido', () => {
    const c = ctx({ 'agent:LLM': { output: 'dice "hola"\nadiós' } });
    const body = interpolate('{"text":"{{agent:LLM.output}}"}', c, true);
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body).text).toBe('dice "hola"\nadiós');
  });

  it('hasTemplate detecta placeholders', () => {
    expect(hasTemplate('a {{x}} b')).toBe(true);
    expect(hasTemplate('sin nada')).toBe(false);
  });

  // Revisión adversarial M12 — regresiones:

  it('jsonSafe con valor NO-string (objeto/array) no rompe ni inyecta el JSON del cuerpo', () => {
    const c = ctx({ 'connector:c': { payload: { a: 1, evil: '#atacante' } } });
    const body = interpolate('{"channel":"#safe","text":"{{connector:c.payload}}"}', c, true);
    expect(() => JSON.parse(body)).not.toThrow(); // el objeto va serializado DENTRO de la cadena
    expect(JSON.parse(body).channel).toBe('#safe'); // no se inyecta ninguna clave nueva
    expect(JSON.parse(body).text).toBe('{"a":1,"evil":"#atacante"}');
  });

  it('claves heredadas del prototipo resuelven a vacío (nunca funciones ni Object.prototype)', () => {
    const empty = ctx({});
    expect(interpolate('a{{toString}}b', empty)).toBe('ab');
    expect(interpolate('a{{constructor}}b', empty)).toBe('ab');
    expect(interpolate('a{{__proto__}}b', empty)).toBe('ab');
    expect(interpolate('a{{constructor.name}}b', empty)).toBe('ab');
    // y en modo jsonSafe no debe lanzar TypeError (era el bug)
    expect(() => interpolate('{"t":"{{toString}}"}', empty, true)).not.toThrow();
  });

  it('resuelve claves compuestas cuya nodeKey contiene «.» (prefijo más largo)', () => {
    const c = ctx({ 'connector:read.msg': { bodyPreview: 'hola' } });
    expect(interpolate('{{connector:read.msg.bodyPreview}}', c)).toBe('hola');
  });
});
