import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EVENT_PROPS, EVENT_NAMES, parseAnalyticsEvent, propsSchemaFor, AnalyticsBatchSchema, ANALYTICS_SCHEMA_VERSION } from './analytics';

/**
 * El guardián de la privacidad. La regla —«ningún texto sin acotar en la analítica»— no se sostiene con
 * un comentario: se sostiene con esto. Sin este test, el primer campo `z.string()` que alguien añada con
 * prisa convierte la tabla de eventos en un vertedero de texto libre, que es exactamente por donde se
 * escapan los secretos y el contenido de los flujos.
 */
const isBareString = (def: any): boolean => {
  if (def?.typeName !== 'ZodString') return false;
  const checks: Array<{ kind: string }> = def.checks ?? [];
  // Acotado = tiene forma (regex) o al menos un tope de longitud. Un string a pelo cabe cualquier cosa.
  return !checks.some((c) => c.kind === 'regex' || c.kind === 'max' || c.kind === 'uuid' || c.kind === 'datetime');
};

/** Recorre un esquema y devuelve las rutas donde hay un texto sin acotar. */
function bareStringPaths(schema: z.ZodTypeAny, path = ''): string[] {
  const def: any = (schema as any)._def;
  if (!def) return [];
  if (isBareString(def)) return [path || '<raíz>'];
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      return Object.entries(shape).flatMap(([k, v]) => bareStringPaths(v as z.ZodTypeAny, path ? `${path}.${k}` : k));
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return bareStringPaths(def.innerType, path);
    case 'ZodArray':
      return bareStringPaths(def.type, `${path}[]`);
    case 'ZodUnion':
      return def.options.flatMap((o: z.ZodTypeAny, i: number) => bareStringPaths(o, `${path}|${i}`));
    default:
      return [];
  }
}

describe('Analytics — la privacidad es estructural, no una promesa', () => {
  it('NINGÚN evento acepta texto libre (si esto falla, alguien abrió una vía de fuga)', () => {
    const leaks: string[] = [];
    for (const [name, schema] of Object.entries(EVENT_PROPS)) {
      for (const p of bareStringPaths(schema as z.ZodTypeAny)) leaks.push(`${name}.${p}`);
    }
    expect(leaks).toEqual([]);
  });

  it('el detector funciona: reconocería un string a pelo si se colara', () => {
    expect(bareStringPaths(z.object({ malo: z.string() }))).toEqual(['malo']);
    expect(bareStringPaths(z.object({ bueno: z.string().regex(/^[a-z]+$/) }))).toEqual([]);
    expect(bareStringPaths(z.object({ anidado: z.object({ malo: z.string() }).optional() }))).toEqual(['anidado.malo']);
  });

  it('el error NO puede llevar mensaje: solo un código conocido', () => {
    const conMensaje = propsSchemaFor('error.displayed').safeParse({
      kind: 'api',
      code: 'not-found',
      message: 'Bearer af_secreto expiró',
    });
    expect(conMensaje.success).toBe(false); // `.strict()` rechaza lo que no está en el registro
  });

  it('la búsqueda NO puede llevar el texto tecleado', () => {
    const conTexto = propsSchemaFor('search.performed').safeParse({
      scope: 'marketplace',
      queryHash: 'a'.repeat(32),
      queryLenBucket: '4-8',
      tokenCount: 2,
      resultCount: 5,
      query: 'nombre de un cliente',
    });
    expect(conTexto.success).toBe(false);
  });
});

const evento = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  at: '2026-07-18T10:00:00.000Z',
  sessionId: '22222222-2222-4222-8222-222222222222',
  seq: 3,
  name: 'page.viewed',
  surface: '/workflows',
  props: {},
  ...over,
});

describe('Analytics — validación del evento', () => {
  it('acepta un evento bien formado', () => {
    expect(parseAnalyticsEvent(evento())).not.toBeNull();
  });

  it('rechaza un nombre que no está en el catálogo (cardinalidad infinita = dashboard inconsultable)', () => {
    expect(parseAnalyticsEvent(evento({ name: 'lo.que.me.invente' }))).toBeNull();
  });

  it('rechaza una URL real como pantalla: solo entra el PATRÓN de ruta', () => {
    // Guardar la URL metería el token de /invite/:token y cualquier query string en la tabla.
    expect(parseAnalyticsEvent(evento({ surface: '/invite/abc123token' }))).toBeNull();
    expect(parseAnalyticsEvent(evento({ surface: '/invite/:token' }))).not.toBeNull();
  });

  it('rechaza props que no están en el registro de ese evento', () => {
    expect(parseAnalyticsEvent(evento({ name: 'button.clicked', props: { element: 'run', extra: 'x' } }))).toBeNull();
    expect(parseAnalyticsEvent(evento({ name: 'button.clicked', props: { element: 'run' } }))).not.toBeNull();
  });

  it('el cliente NO puede decir de qué workspace es un evento', () => {
    // `.strict()` en el sobre: si colara, cualquiera escribiría en la analítica de otro tenant.
    expect(parseAnalyticsEvent(evento({ workspaceId: 'ws_ajeno' }))).toBeNull();
    expect(parseAnalyticsEvent(evento({ userId: 'otro' }))).toBeNull();
  });

  it('acota la permanencia: nada de duraciones absurdas', () => {
    expect(parseAnalyticsEvent(evento({ name: 'view.ended', props: { visibleMs: 300_000, capped: true } }))).not.toBeNull();
    expect(parseAnalyticsEvent(evento({ name: 'view.ended', props: { visibleMs: 999_999_999, capped: false } }))).toBeNull();
  });

  it('el lote tiene tope (un cliente roto no puede mandar un megabyte)', () => {
    const muchos = Array.from({ length: 51 }, () => evento());
    expect(AnalyticsBatchSchema.safeParse({ v: ANALYTICS_SCHEMA_VERSION, events: muchos }).success).toBe(false);
    expect(AnalyticsBatchSchema.safeParse({ v: ANALYTICS_SCHEMA_VERSION, events: muchos.slice(0, 50) }).success).toBe(true);
  });

  it('todos los nombres del catálogo tienen esquema de props resoluble', () => {
    for (const n of EVENT_NAMES) expect(() => propsSchemaFor(n)).not.toThrow();
  });
});
