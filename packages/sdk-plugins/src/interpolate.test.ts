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
});
