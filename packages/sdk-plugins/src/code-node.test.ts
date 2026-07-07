import { describe, it, expect } from 'vitest';
import { emptyContext } from '@core/contracts';
import { CodeNodeExecutor } from './code-node';

const run = (code: string, variables: Record<string, unknown> = {}) =>
  new CodeNodeExecutor().execute({
    executionId: 'e1',
    workspaceId: 'ws1',
    nodeKey: 'transformar',
    config: { code },
    context: { ...emptyContext(), variables },
    signal: new AbortController().signal,
    emit: () => {},
  });

describe('CodeNodeExecutor (nodo Transformar datos, M46)', () => {
  it('transforma la salida de pasos previos y la expone en {{code:KEY.output}}', async () => {
    const res = await run(
      "const items = input['agent:extraer.output'].items; return items.map(x => ({ name: x.name, total: x.qty * x.price }));",
      { 'agent:extraer.output': { items: [{ name: 'A', qty: 2, price: 10 }, { name: 'B', qty: 1, price: 5 }] } },
    );
    expect((res.context.variables['code:transformar'] as { output: unknown }).output).toEqual([
      { name: 'A', total: 20 },
      { name: 'B', total: 5 },
    ]);
    expect(res.control).toEqual({ kind: 'continue' });
  });

  it('construye un string (p. ej. una consulta) a partir de input', async () => {
    const res = await run("return 'SELECT Id FROM Product2 WHERE Code IN (' + input.codes.map(c => \"'\"+c+\"'\").join(',') + ')';", {
      codes: ['P1', 'P2'],
    });
    expect((res.context.variables['code:transformar'] as { output: unknown }).output).toBe("SELECT Id FROM Product2 WHERE Code IN ('P1','P2')");
  });

  it('AISLAMIENTO: el script NO puede leer los secretos del proceso (process.env)', async () => {
    const res = await run("return typeof process !== 'undefined' ? process.env : 'sin-process';");
    const out = res.context.variables['code:transformar'] as { output?: unknown; error?: string };
    // `process` no existe en el contexto V8 → o bien devuelve el marcador, o da error; NUNCA el env real.
    expect(out.output === 'sin-process' || typeof out.error === 'string').toBe(true);
    expect(JSON.stringify(out)).not.toContain('DATABASE_URL');
  });

  it('AISLAMIENTO: no hay require/fetch disponibles', async () => {
    const res = await run("return typeof require + ',' + typeof fetch;");
    const out = res.context.variables['code:transformar'] as { output?: unknown; error?: string };
    // Ambos deben ser 'undefined' (o error). Nunca 'function'.
    expect(out.output === 'undefined,undefined' || typeof out.error === 'string').toBe(true);
  });

  it('un script vacío o con error devuelve un error legible, sin romper el flujo', async () => {
    const vacio = await run('   ');
    expect((vacio.context.variables['code:transformar'] as { error: string }).error).toContain('falta el script');
    const roto = await run('return input.a.b.c;'); // TypeError: a is undefined
    expect((roto.context.variables['code:transformar'] as { error?: string }).error).toBeTruthy();
    expect(roto.control).toEqual({ kind: 'continue' }); // no rompe: sigue el flujo
  });
});
