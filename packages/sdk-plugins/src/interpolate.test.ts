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

// --- M82: fechas relativas -----------------------------------------------------------------------
// Un flujo diario necesita «ayer», no una fecha fija que se queda vieja al segundo día.
describe('interpolate — {{fecha}} relativa a la ejecución', () => {
  const NOW = Date.parse('2026-07-16T11:30:45.123Z');
  const base = ctx({});

  it('{{fecha}} da el instante de la ejecución en ISO UTC, sin milisegundos', () => {
    expect(interpolate('{{fecha}}', base, false, NOW)).toBe('2026-07-16T11:30:45');
  });

  it('acepta desplazamientos en s/m/h/d, hacia atrás y hacia delante', () => {
    expect(interpolate('{{fecha:-1d}}', base, false, NOW)).toBe('2026-07-15T11:30:45');
    expect(interpolate('{{fecha:-36h}}', base, false, NOW)).toBe('2026-07-14T23:30:45');
    expect(interpolate('{{fecha:+7d}}', base, false, NOW)).toBe('2026-07-23T11:30:45');
    expect(interpolate('{{fecha:-30m}}', base, false, NOW)).toBe('2026-07-16T11:00:45');
  });

  it('`.date` da solo el día, para las APIs que no quieren hora', () => {
    expect(interpolate('{{fecha:-1d.date}}', base, false, NOW)).toBe('2026-07-15');
  });

  it('una variable llamada «fecha» NO puede sombrear la palabra reservada', () => {
    const conVar = ctx({ fecha: 'DE-OTRO-SITIO' });
    expect(interpolate('{{fecha}}', conVar, false, NOW)).toBe('2026-07-16T11:30:45');
  });

  it('lo que no es una fecha válida sigue el camino normal (no se traga otras refs)', () => {
    const v = ctx({ fechado: 'X', 'fecha:mal': 'Y' });
    expect(interpolate('{{fechado}}', v, false, NOW)).toBe('X'); // no empieza por «fecha» + separador
    expect(interpolate('{{fecha:mal}}', v, false, NOW)).toBe('Y'); // desplazamiento inválido → variable
  });

  it('sirve para una ventana de 24 h en una URL (el caso que lo motivó)', () => {
    const url = interpolate('https://api/x?from={{fecha:-2d}}&to={{fecha:-1d}}', base, false, NOW);
    expect(url).toBe('https://api/x?from=2026-07-14T11:30:45&to=2026-07-15T11:30:45');
  });

  it('un desplazamiento fuera de rango degrada a vacío, NO lanza (está en el camino de cada nodo)', () => {
    // `{{fecha:+99999999d}}` (un cero de más al escribir «días») ya roza el límite de Date: si esto lanzara,
    // un typo en un campo tumbaría el flujo entero en vez de resolver a ''.
    expect(() => interpolate('{{fecha:+99999999999999d}}', base, false, NOW)).not.toThrow();
    expect(interpolate('{{fecha:+99999999999999d}}', base, false, NOW)).toBe('');
    expect(interpolate('{{fecha:-99999999999999d}}', base, false, NOW)).toBe('');
  });

  it('en modo jsonSafe se incrusta escapada como cualquier otro valor', () => {
    expect(interpolate('{"from":"{{fecha:-1d}}"}', base, true, NOW)).toBe('{"from":"2026-07-15T11:30:45"}');
  });
});
