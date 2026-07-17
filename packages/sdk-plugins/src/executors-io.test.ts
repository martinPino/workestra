import { describe, it, expect, vi } from 'vitest';
import { emptyContext } from '@core/contracts';
import { evalCondition, ConditionNodeExecutor, HttpNodeExecutor, parseHeaders, safeHttpJson } from './executors-io';

describe('Condition executor (evaluador seguro)', () => {
  it('evalúa comparaciones sobre el contexto', () => {
    const ctx = { ...emptyContext(), variables: { count: 5, name: 'ada' } };
    expect(evalCondition('variables.count > 0', ctx)).toBe(true);
    expect(evalCondition('variables.count >= 5', ctx)).toBe(true);
    expect(evalCondition('variables.count < 3', ctx)).toBe(false);
    expect(evalCondition('variables.name == ada', ctx)).toBe(true);
    expect(evalCondition('variables.missing == 1', ctx)).toBe(false);
    expect(evalCondition('true', ctx)).toBe(true);
    expect(evalCondition('nonsense', ctx)).toBe(false);
  });

  it('soporta Y (&&), O (||) y «contiene» (~) del constructor visual (M21)', () => {
    const ctx = { ...emptyContext(), variables: { count: 5, name: 'ada lovelace' } };
    expect(evalCondition('variables.count > 0 && variables.name == ada lovelace', ctx)).toBe(true);
    expect(evalCondition('variables.count > 10 && variables.name == ada lovelace', ctx)).toBe(false);
    expect(evalCondition('variables.count > 10 || variables.count < 3', ctx)).toBe(false);
    expect(evalCondition('variables.count > 10 || variables.count >= 5', ctx)).toBe(true);
    expect(evalCondition('variables.name ~ lovelace', ctx)).toBe(true);
    expect(evalCondition('variables.name ~ Lovelace', ctx)).toBe(true); // case-insensitive
    expect(evalCondition('variables.name ~ xyz', ctx)).toBe(false);
  });

  it('ramifica según la SALIDA de un agente u otro nodo (clave con «:», M72)', () => {
    // Las salidas de nodo se guardan con clave compuesta en variables: `agent:qa` = { output, tools }.
    const ctx = {
      ...emptyContext(),
      variables: { 'agent:qa': { output: 'FALLA: el botón de comprar no responde' }, 'connector:c': { status: 200 } },
    };
    expect(evalCondition('agent:qa.output ~ FALLA', ctx)).toBe(true); // la plantilla «Equipo QA» depende de esto
    expect(evalCondition('agent:qa.output ~ falla', ctx)).toBe(true); // case-insensitive
    expect(evalCondition('agent:qa.output ~ PASA', ctx)).toBe(false);
    expect(evalCondition('connector:c.status == 200', ctx)).toBe(true);
    expect(evalCondition('agent:inexistente.output ~ x', ctx)).toBe(false); // referencia ausente → falso, no rompe
  });

  it('el executor devuelve la rama y anota el resultado en el contexto', async () => {
    const exec = new ConditionNodeExecutor();
    const res = await exec.execute({
      executionId: 'e1',
      workspaceId: 'ws1',
      nodeKey: 'c1',
      config: { expression: 'variables.x > 10' },
      context: { ...emptyContext(), variables: { x: 42 } },
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(res.control).toEqual({ kind: 'branch', handle: 'true' });
    expect(res.context.variables['condition:c1']).toBe(true);
  });

  it('persiste la decisión de flujo `flow:` para que el runner PODE la rama no tomada (M14)', async () => {
    const exec = new ConditionNodeExecutor();
    const run = (x: number) =>
      exec.execute({
        executionId: 'e', workspaceId: 'ws', nodeKey: 'c1',
        config: { expression: 'variables.x > 10' },
        context: { ...emptyContext(), variables: { x } },
        signal: new AbortController().signal, emit: () => {},
      });
    expect((await run(42)).context.variables['flow:c1']).toEqual({ handles: ['true'] });
    expect((await run(1)).context.variables['flow:c1']).toEqual({ handles: ['false'] });
  });
});

describe('HTTP executor (método + cabeceras + cuerpo + interpolación · M31)', () => {
  it('parseHeaders tolera vacío/JSON inválido y castea valores a string', () => {
    expect(parseHeaders('')).toEqual({});
    expect(parseHeaders('no es json')).toEqual({});
    expect(parseHeaders('[1,2]')).toEqual({}); // array no es un mapa de cabeceras
    expect(parseHeaders('{"Authorization":"Bearer x","X-N":5}')).toEqual({ Authorization: 'Bearer x', 'X-N': '5' });
  });

  it('safeHttpJson parsea JSON pequeño y rechaza inválido o enorme', () => {
    expect(safeHttpJson('{"a":1}')).toEqual({ a: 1 });
    expect(safeHttpJson('nope')).toBeUndefined();
    expect(safeHttpJson('"' + 'x'.repeat(64_001) + '"')).toBeUndefined(); // >64 KB
  });

  it('interpola url/cabeceras/cuerpo, fija content-type y expone json en http:KEY', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, id: 7 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const exec = new HttpNodeExecutor();
    const res = await exec.execute({
      executionId: 'e', workspaceId: 'ws', nodeKey: 'llamada',
      config: {
        method: 'post', // se normaliza a POST
        url: 'https://api.example.com/{{ruta}}',
        headers: '{"Authorization":"Bearer {{clave}}"}',
        body: '{"title":"{{http:prev.json.title}}"}',
      },
      context: { ...emptyContext(), variables: { ruta: 'send', clave: 'SECRETO', 'http:prev': { json: { title: 'Hola' } } } },
      signal: new AbortController().signal, emit: () => {},
    });
    expect(calls[0].url).toBe('https://api.example.com/send');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer SECRETO'); // API key resuelta desde una variable
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: 'Hola' }); // salida de un paso previo
    const stored = res.context.variables['http:llamada'] as Record<string, unknown>;
    expect(stored.status).toBe(200);
    expect(stored.json).toEqual({ ok: true, id: 7 });
    vi.unstubAllGlobals();
  });

  it('sin URL devuelve error y NO llama a la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const exec = new HttpNodeExecutor();
    const res = await exec.execute({
      executionId: 'e', workspaceId: 'ws', nodeKey: 'x',
      config: { method: 'GET', url: '' },
      context: emptyContext(), signal: new AbortController().signal, emit: () => {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((res.context.variables['http:x'] as Record<string, unknown>).error).toMatch(/falta la URL/);
    vi.unstubAllGlobals();
  });
});

// Una respuesta JSON que se pasa del tope deja de exponerse a los pasos siguientes. Que eso ocurra en
// SILENCIO es lo que convierte «subir pageSize» en un boletín vacío que nadie sabe explicar.
describe('HTTP — respuesta JSON demasiado grande (M82)', () => {
  const httpRun = async (bodyText: string) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bodyText, { status: 200 })));
    const res = await new HttpNodeExecutor().execute({
      executionId: 'e',
      workspaceId: 'ws',
      nodeKey: 'news',
      config: { url: 'https://api.example/x' },
      context: emptyContext(),
      signal: new AbortController().signal,
      emit: () => {},
    } as never);
    vi.unstubAllGlobals();
    return (res.context.variables as Record<string, Record<string, unknown>>)['http:news'];
  };

  const bigJson = JSON.stringify({ articles: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'x'.repeat(200) })) });

  it('avisa de que la respuesta no se puede leer desde otros pasos, y de cómo arreglarlo', async () => {
    expect(bigJson.length).toBeGreaterThan(64_000); // premisa del test
    const out = await httpRun(bigJson);
    expect(out.json).toBeUndefined();
    expect(String(out.jsonOmitido)).toContain('{{http:news.json.…}}');
    expect(String(out.jsonOmitido)).toContain('pageSize'); // dice cómo arreglarlo, no solo que falló
  });

  it('una respuesta pequeña se expone y NO avisa', async () => {
    const out = await httpRun('{"articles":[{"i":1}]}');
    expect(out.json).toEqual({ articles: [{ i: 1 }] });
    expect(out.jsonOmitido).toBeUndefined();
  });

  it('un cuerpo grande que NO es JSON (p. ej. HTML) no le echa la culpa al tope', async () => {
    const out = await httpRun('<html>' + 'x'.repeat(70_000));
    expect(out.json).toBeUndefined();
    expect(out.jsonOmitido).toBeUndefined();
  });
});
