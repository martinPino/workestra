import { describe, it, expect } from 'vitest';
import type {
  Execution,
  ExecutionStatus,
  ExecutionContext,
  ExecutionEvent,
  INodeExecutor,
  NodeExecutionContext,
  NodeResult,
  NodeType,
  WorkflowGraph,
  WorkflowNode,
} from '@core/contracts';
import { emptyContext } from '@core/contracts';
import { WorkflowRunner, type RunInput } from './workflow-runner';
import type {
  IExecutionRepository,
  IContextStore,
  IEventPublisher,
  INodeExecutorRegistry,
  NewExecution,
  NewExecutionLog,
} from './ports';

// ---------- Fakes inline de los puertos ----------

class FakeExecRepo implements IExecutionRepository {
  private map = new Map<string, Execution>();
  private c = 0;
  async create(e: NewExecution): Promise<Execution> {
    const id = `exec_${++this.c}`;
    const ex: Execution = {
      id,
      workflowVersionId: e.workflowVersionId,
      workspaceId: e.workspaceId,
      parentExecutionId: null,
      status: 'QUEUED',
      triggerType: e.triggerType as Execution['triggerType'],
      tokensUsed: 0,
      costEstimate: 0,
      startedAt: null,
      finishedAt: null,
    };
    this.map.set(id, ex);
    return ex;
  }
  async get(id: string) {
    return this.map.get(id) ?? null;
  }
  async list(q: { workspaceId: string; status?: ExecutionStatus; limit?: number }) {
    return [...this.map.values()].filter((e) => e.workspaceId === q.workspaceId && (!q.status || e.status === q.status));
  }
  async updateStatus(id: string, status: ExecutionStatus) {
    const ex = this.map.get(id);
    if (ex) ex.status = status;
  }
  async appendLog(_log: NewExecutionLog) {}
  async addUsage() {}
}

class FakeContextStore implements IContextStore {
  last: ExecutionContext | undefined;
  async load(): Promise<ExecutionContext> {
    return emptyContext();
  }
  async checkpoint(_id: string, ctx: ExecutionContext) {
    this.last = ctx;
  }
}

class Registry implements INodeExecutorRegistry {
  private m = new Map<NodeType, INodeExecutor>();
  set(ex: INodeExecutor) {
    this.m.set(ex.type, ex);
    return this;
  }
  get(t: NodeType) {
    return this.m.get(t);
  }
}

/** Executor programable por la config del nodo: set/failTimes/sleep. */
class ScriptedExecutor implements INodeExecutor {
  readonly type: NodeType = 'tool';
  private attempts = new Map<string, number>();
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const c = ctx.config as { sleep?: number; failTimes?: number; set?: { key: string; value: unknown } };
    if (c.sleep) await new Promise((r) => setTimeout(r, c.sleep));
    if (c.failTimes) {
      const n = (this.attempts.get(ctx.nodeKey) ?? 0) + 1;
      this.attempts.set(ctx.nodeKey, n);
      if (n <= c.failTimes) throw new Error(`fallo intencional #${n}`);
    }
    const variables = { ...ctx.context.variables };
    if (c.set) variables[c.set.key] = c.set.value;
    return { context: { ...ctx.context, variables }, control: { kind: 'continue' } };
  }
}

const node = (key: string, config: Record<string, unknown> = {}): WorkflowNode => ({ key, type: 'tool', config, position: { x: 0, y: 0 } });

function harness() {
  const events: ExecutionEvent[] = [];
  const store = new FakeContextStore();
  const runner = new WorkflowRunner({
    executions: new FakeExecRepo(),
    context: store,
    events: { async publish(e) { events.push(e); } } as IEventPublisher,
    registry: new Registry().set(new ScriptedExecutor()),
    clock: { now: () => new Date(0) },
    ids: { next: () => 'id' },
  });
  const run = (graph: WorkflowGraph, extra: Partial<RunInput> = {}) =>
    runner.run({ workflowVersionId: 'v', workspaceId: 'ws', graph, triggerType: 'manual', initialContext: emptyContext(), ...extra });
  return { run, events, store };
}

const nodeKeysOf = (events: ExecutionEvent[], type: string): string[] =>
  events.filter((e) => e.type === type).map((e) => (e as { nodeKey: string }).nodeKey);

describe('WorkflowRunner — política de despacho paralela (M4)', () => {
  it('ejecuta en paralelo el fan-out y fusiona ambas ramas (fan-in)', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('a'), node('b', { set: { key: 'b', value: 1 } }), node('c', { set: { key: 'c', value: 2 } })],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    const { run, events, store } = harness();
    await run(graph);
    expect(events.some((e) => e.type === 'execution.succeeded')).toBe(true);
    expect(new Set(nodeKeysOf(events, 'node.succeeded'))).toEqual(new Set(['a', 'b', 'c']));
    expect(store.last?.variables.b).toBe(1);
    expect(store.last?.variables.c).toBe(2);
  });

  it('el fan-in es DETERMINISTA ante conflicto, sin depender del orden de finalización', async () => {
    const graph: WorkflowGraph = {
      nodes: [node('a'), node('b', { sleep: 15, set: { key: 'shared', value: 'B' } }), node('c', { set: { key: 'shared', value: 'C' } })],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    for (let i = 0; i < 3; i++) {
      const { run, store } = harness();
      await run(graph);
      expect(store.last?.variables.shared).toBe('C'); // sorted nodeKey => c gana siempre
    }
  });

  it('reintenta un nodo transitoriamente fallido y termina con éxito', async () => {
    const graph: WorkflowGraph = { nodes: [node('x', { failTimes: 2, retry: { maxAttempts: 3, backoffMs: 1 } })], edges: [] };
    const { run, events } = harness();
    await run(graph);
    expect(events.some((e) => e.type === 'execution.succeeded')).toBe(true);
    expect(events.filter((e) => e.type === 'node.started')).toHaveLength(3); // 3 intentos
    expect(events.some((e) => e.type === 'node.succeeded')).toBe(true);
  });

  it('aplica timeout por nodo y falla la ejecución si se excede', async () => {
    const graph: WorkflowGraph = { nodes: [node('x', { sleep: 50, timeoutMs: 10 })], edges: [] };
    const { run, events } = harness();
    await expect(run(graph)).rejects.toThrow();
    expect(events.some((e) => e.type === 'node.failed')).toBe(true);
    expect(events.some((e) => e.type === 'execution.failed')).toBe(true);
  });

  it('startSeq: la reanudación continúa el stream de forma MONÓTONA (M6, replay)', async () => {
    const graph: WorkflowGraph = { nodes: [node('a')], edges: [] };
    const { run, events } = harness();
    await run(graph, { executionId: 'exec_r', resumeCompleted: [], startSeq: 10 });
    const seqs = events.map((e) => e.seq);
    expect(Math.min(...seqs)).toBe(10); // arranca donde le dijeron
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // monótono creciente
  });
});
