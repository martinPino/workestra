import { describe, it, expect } from 'vitest';
import { emptyContext, type ExecutionContext, type NodeExecutionContext } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';
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
