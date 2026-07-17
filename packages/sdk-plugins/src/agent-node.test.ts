import { describe, it, expect } from 'vitest';
import { emptyContext, type ExecutionContext, type NodeExecutionContext } from '@core/contracts';
import type { MemoryScope } from '@core/contracts';
import type { IAgentRepository, IMemoryStore } from '@core/engine';
import { AgentNodeExecutor } from './agent-node';
import type { AgentRuntime } from './agent-runtime';

// Runtime falso: como el real, escribe `agent:<name>` y refleja la `task` recibida en el output.
const fakeRuntime = {
  async invoke(agent: { name: string }, ctx: ExecutionContext) {
    const task = (ctx.variables as Record<string, unknown>).task;
    return {
      context: { ...ctx, variables: { ...ctx.variables, [`agent:${agent.name}`]: { output: `out:${task ?? 'default'}`, tools: [] } } },
      output: '',
      tokens: 1,
      cost: 0,
    };
  },
} as unknown as AgentRuntime;

const fakeAgents = { async getInWorkspace() { return null; } } as unknown as IAgentRepository;

const run = (nodeKey: string, config: Record<string, unknown>, context: ExecutionContext) =>
  new AgentNodeExecutor(fakeRuntime, fakeAgents, 'llm').execute({
    executionId: 'e',
    workspaceId: 'ws',
    nodeKey,
    config,
    context,
    signal: new AbortController().signal,
    emit: () => {},
  } as NodeExecutionContext);

describe('AgentNodeExecutor — saneamiento de contexto (fixes revisión M13)', () => {
  it('alias ÚNICO por nodeKey además del alias por nombre (dos «LLM» no colisionan)', async () => {
    const res = await run('n1', {}, emptyContext());
    const v = res.context.variables as Record<string, unknown>;
    expect(v['agent:LLM']).toBeDefined(); // alias por nombre (inline default)
    expect(v['agent:n1']).toEqual(v['agent:LLM']); // alias único por nodeKey
  });

  it('el `task` del input de ESTE nodo NO se filtra aguas abajo', async () => {
    const res = await run('a', { input: 'Tarea del nodo A' }, emptyContext());
    const v = res.context.variables as Record<string, unknown>;
    // el agente sí usó la task para su salida...
    expect((v['agent:LLM'] as { output: string }).output).toBe('out:Tarea del nodo A');
    // ...pero el contexto de salida NO arrastra esa task (el contexto entrante no tenía task).
    expect('task' in v).toBe(false);
  });

  it('un `task` global previo (de la ejecución) SÍ se preserva', async () => {
    const ctx = { ...emptyContext(), variables: { task: 'objetivo global' } };
    const res = await run('b', {}, ctx);
    const v = res.context.variables as Record<string, unknown>;
    expect(v.task).toBe('objetivo global'); // no se pierde el task de nivel ejecución
    expect((v['agent:LLM'] as { output: string }).output).toBe('out:objetivo global');
  });
});

// --- M82: «no repetir lo que ya escribió» -----------------------------------------------------------
// Un paso de IA que corre a diario arranca en blanco cada vez, así que vuelve a elegir lo mismo. Con la
// casilla puesta, el nodo apunta lo que produjo y mañana se lo enseña al modelo.

/** Almacén de memoria de juguete: `sdk-plugins` habla con el PUERTO, no con el adaptador de infra. */
class FakeMemory implements IMemoryStore {
  private readonly data = new Map<string, unknown>();
  private k(ws: string, s: MemoryScope, o: string, key: string) {
    return `${ws}:${s}:${o}:${key}`;
  }
  async get(ws: string, s: MemoryScope, o: string, key: string) {
    return this.data.get(this.k(ws, s, o, key));
  }
  async set(ws: string, s: MemoryScope, o: string, key: string, v: unknown) {
    this.data.set(this.k(ws, s, o, key), v);
  }
  async append(ws: string, s: MemoryScope, o: string, key: string, v: unknown) {
    const cur = this.data.get(this.k(ws, s, o, key));
    const arr = Array.isArray(cur) ? [...cur] : cur === undefined ? [] : [cur];
    arr.push(v);
    this.data.set(this.k(ws, s, o, key), arr);
  }
}

/** Runtime que devuelve un output REAL (el fake de arriba devuelve ''), y captura la task que le llegó. */
const echoRuntime = (output: string, seen: { task?: string } = {}) =>
  ({
    async invoke(agent: { name: string }, ctx: ExecutionContext) {
      seen.task = String((ctx.variables as Record<string, unknown>).task ?? '');
      return {
        context: { ...ctx, variables: { ...ctx.variables, [`agent:${agent.name}`]: { output, tools: [] } } },
        output,
        tokens: 1,
        cost: 0,
      };
    },
  }) as unknown as AgentRuntime;

const runMem = (
  opts: {
    nodeKey?: string;
    workflowId?: string;
    config?: Record<string, unknown>;
    context?: ExecutionContext;
    memory?: IMemoryStore;
    output?: string;
    seen?: { task?: string };
  } = {},
) =>
  new AgentNodeExecutor(echoRuntime(opts.output ?? 'DIGEST DE HOY', opts.seen), fakeAgents, 'llm', undefined, opts.memory).execute({
    executionId: 'e',
    workspaceId: 'ws',
    workflowId: opts.workflowId ?? 'wf_1',
    nodeKey: opts.nodeKey ?? 'digest',
    config: opts.config ?? { input: 'Elige 5 noticias', noRepetir: true },
    context: opts.context ?? emptyContext(),
    signal: new AbortController().signal,
    emit: () => {},
  } as NodeExecutionContext);

const sentOf = (m: FakeMemory, wf = 'wf_1', key = 'digest') => m.get('ws', 'persistent', `node:${wf}:${key}`, 'sent');

describe('AgentNodeExecutor — «no repetir lo que ya escribió» (M82)', () => {
  it('sin la casilla NO toca la memoria (es opt-in y no cuesta nada apagado)', async () => {
    const mem = new FakeMemory();
    await runMem({ memory: mem, config: { input: 'Elige 5 noticias' } });
    expect(await sentOf(mem)).toBeUndefined();
  });

  it('la primera ejecución no tiene nada que recordar, y apunta su salida', async () => {
    const mem = new FakeMemory();
    const seen: { task?: string } = {};
    await runMem({ memory: mem, seen, output: 'Noticia A' });
    expect(seen.task).toBe('Elige 5 noticias'); // sin bloque: no había nada escrito
    expect(await sentOf(mem)).toEqual(['Noticia A']);
  });

  it('la segunda ejecución ve lo de la primera, delimitado y marcado como DATO', async () => {
    const mem = new FakeMemory();
    const seen: { task?: string } = {};
    await runMem({ memory: mem, output: 'Noticia A' });
    await runMem({ memory: mem, seen, output: 'Noticia B' });
    expect(seen.task).toContain('Elige 5 noticias'); // la tarea original sigue ahí
    expect(seen.task).toContain('Noticia A'); // y sabe lo que ya escribió
    expect(seen.task).toContain('<ya-escrito>');
    expect(seen.task).toContain('no repitas'); // se le pide explícitamente
    expect(await sentOf(mem)).toEqual(['Noticia A', 'Noticia B']);
  });

  it('le recuerda las últimas 7 salidas, no las primeras (la memoria envejece)', async () => {
    const mem = new FakeMemory();
    for (let i = 1; i <= 9; i++) await runMem({ memory: mem, output: `Digest ${i}` });
    const seen: { task?: string } = {};
    await runMem({ memory: mem, seen, output: 'Digest 10' });
    expect(seen.task).not.toContain('Digest 1\n'); // la más vieja ya no entra
    expect(seen.task).toContain('Digest 9'); // la más reciente sí
    expect(seen.task).toContain('Digest 3');
  });

  it('dos flujos con un nodo homónimo NO comparten memoria (las plantillas fijan claves como «digest»)', async () => {
    const mem = new FakeMemory();
    await runMem({ memory: mem, workflowId: 'wf_1', output: 'Del flujo 1' });
    const seen: { task?: string } = {};
    await runMem({ memory: mem, workflowId: 'wf_2', seen, output: 'Del flujo 2' });
    expect(seen.task).not.toContain('Del flujo 1'); // el flujo 2 no lee lo del flujo 1
    expect(await sentOf(mem, 'wf_1')).toEqual(['Del flujo 1']);
    expect(await sentOf(mem, 'wf_2')).toEqual(['Del flujo 2']);
  });

  it('sin workflowId no hay memoria: la identidad no sería estable (falla cerrado)', async () => {
    const mem = new FakeMemory();
    const seen: { task?: string } = {};
    await runMem({ memory: mem, workflowId: undefined, seen });
    expect(seen.task).toBe('Elige 5 noticias');
    expect(await mem.get('ws', 'persistent', 'node:undefined:digest', 'sent')).toBeUndefined();
  });

  it('si la memoria falla, el paso SIGUE funcionando (falla abierto: un repetido, no un flujo roto)', async () => {
    const rota: IMemoryStore = {
      async get() {
        throw new Error('memoria caída');
      },
      async set() {
        throw new Error('memoria caída');
      },
      async append() {
        throw new Error('memoria caída');
      },
    };
    const seen: { task?: string } = {};
    const res = await runMem({ memory: rota, seen, output: 'Sale igual' });
    expect(seen.task).toBe('Elige 5 noticias');
    expect((res.context.variables as Record<string, unknown>)['agent:digest']).toEqual({ output: 'Sale igual', tools: [] });
    expect(res.control).toEqual({ kind: 'continue' });
  });

  it('sin memoria inyectada (modo sin infra) tampoco rompe', async () => {
    const res = await runMem({ memory: undefined });
    expect(res.control).toEqual({ kind: 'continue' });
  });

  it('no pisa la tarea que el runtime deriva del contexto cuando el nodo no define entrada', async () => {
    // Sin `input` ni task entrante, la tarea sale del ticket: fijarla aquí cambiaría lo que hace el paso.
    const mem = new FakeMemory();
    await runMem({ memory: mem, config: { noRepetir: true }, output: 'Algo' });
    const seen: { task?: string } = {};
    await runMem({ memory: mem, config: { noRepetir: true }, seen, output: 'Otra cosa' });
    expect(seen.task).toBe(''); // no se inyecta: el runtime derivará la tarea del ticket como siempre
  });

  it('un `task` entrante sirve de base para el bloque (no se pierde)', async () => {
    const mem = new FakeMemory();
    const ctx = { ...emptyContext(), variables: { task: 'objetivo global' } };
    await runMem({ memory: mem, config: { noRepetir: true }, context: ctx, output: 'Lo de ayer' });
    const seen: { task?: string } = {};
    await runMem({ memory: mem, config: { noRepetir: true }, context: ctx, seen, output: 'Lo de hoy' });
    expect(seen.task).toContain('objetivo global');
    expect(seen.task).toContain('Lo de ayer');
  });

  it('recorta salidas largas al apuntarlas (una sola clave no puede crecer sin límite)', async () => {
    const mem = new FakeMemory();
    await runMem({ memory: mem, output: 'x'.repeat(5000) });
    const stored = (await sentOf(mem)) as string[];
    expect(stored[0]).toHaveLength(1500);
  });
});
