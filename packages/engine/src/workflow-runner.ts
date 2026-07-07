import type { WorkflowGraph, ExecutionContext, ExecutionEvent, NodeControl, WorkflowNode, OutgoingEdge } from '@core/contracts';
import { EXECUTION_EVENT_SCHEMA_VERSION } from '@core/contracts';
import { validateDag, createScheduler, mergeContexts, shouldRunNode, stripDisabledNodes, type ContextContribution } from '@core/domain';
import type {
  IExecutionRepository,
  IContextStore,
  IEventPublisher,
  INodeExecutorRegistry,
  IClock,
  IIdGenerator,
  IWorkspaceUsageRepository,
} from './ports';

export interface RunnerDeps {
  executions: IExecutionRepository;
  context: IContextStore;
  events: IEventPublisher;
  registry: INodeExecutorRegistry;
  clock: IClock;
  ids: IIdGenerator;
  /** Contador de cuota por workspace (M33): suma los tokens de ejecución (agentes) hacia el tope diario. */
  usage?: IWorkspaceUsageRepository;
}

export interface RunInput {
  executionId?: string;
  workflowVersionId: string;
  workspaceId: string;
  graph: WorkflowGraph;
  triggerType: string;
  initialContext: ExecutionContext;
  /** Nodos ya completados (resume tras reinicio del worker): se saltan y no se re-ejecutan. */
  resumeCompleted?: string[];
  /**
   * Primer `seq` a estampar (M6). Al reanudar, el llamante lo deriva de `IEventStore.lastSeq()+1`
   * para que el stream sea MONÓTONO entre pausas/reinicios: sin esto el reducer (que ignora
   * `seq <= lastSeq`) descartaría los eventos de la reanudación y el replay quedaría roto.
   */
  startSeq?: number;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type ExecutionEventBody = DistributiveOmit<ExecutionEvent, 'schemaVersion' | 'executionId' | 'at' | 'seq'>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface NodePolicy {
  maxAttempts: number;
  backoffMs: number;
  timeoutMs?: number;
}

function policyOf(config: Record<string, unknown>): NodePolicy {
  const retry = (config.retry ?? {}) as { maxAttempts?: number; backoffMs?: number };
  return {
    maxAttempts: Math.max(1, Number(retry.maxAttempts ?? 1)),
    backoffMs: Math.max(0, Number(retry.backoffMs ?? 0)),
    timeoutMs: config.timeoutMs != null ? Number(config.timeoutMs) : undefined,
  };
}

interface NodeOutcome {
  ok: boolean;
  nodeKey: string;
  context: ExecutionContext;
  control?: NodeControl;
  error?: unknown;
}

/**
 * Motor de ejecución del DAG. En M4 la POLÍTICA de despacho es PARALELA: en cada paso ejecuta
 * concurrentemente el CONJUNTO de nodos listos (fan-out) sobre una copia del contexto base
 * (copy-on-write) y hace fan-in DETERMINISTA con `mergeContexts`. Cada nodo tiene reintentos con
 * backoff y timeout. El contrato del `DagScheduler` (M1) no cambia: solo cambia esta política.
 */
export class WorkflowRunner {
  private seq = 0;
  private workspaceId = ''; // tenant de la ejecución en curso (se pasa a cada nodo, M8)

  constructor(private readonly deps: RunnerDeps) {}

  private async emit(executionId: string, body: ExecutionEventBody): Promise<void> {
    const event = {
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      executionId,
      at: this.deps.clock.now().toISOString(),
      seq: this.seq++,
      ...body,
    } as ExecutionEvent;
    await this.deps.events.publish(event);
  }

  private async emitNode(executionId: string, nodeKey: string, body: Record<string, unknown>): Promise<void> {
    const event = {
      schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
      executionId,
      at: this.deps.clock.now().toISOString(),
      seq: this.seq++,
      nodeKey,
      ...body,
    } as ExecutionEvent;
    await this.deps.events.publish(event);
  }

  private withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
    if (!ms || ms <= 0) return p;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout tras ${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private async runNode(
    executionId: string,
    node: WorkflowNode,
    baseCtx: ExecutionContext,
    outgoing: readonly OutgoingEdge[],
    controller: AbortController,
  ): Promise<NodeOutcome> {
    const key = node.key;
    const executor = this.deps.registry.get(node.type);
    const policy = policyOf(node.config);

    for (let attempt = 1; ; attempt++) {
      const stepKey = `${executionId}:${key}:${attempt}`; // idempotencia por (exec, nodo, intento)
      await this.emit(executionId, { type: 'node.started', nodeKey: key, stepKey });

      if (!executor) {
        await this.deps.executions.appendLog({ executionId, nodeKey: key, stepKey, level: 'warn', status: 'skipped' });
        await this.emit(executionId, { type: 'node.succeeded', nodeKey: key, stepKey });
        return { ok: true, nodeKey: key, context: baseCtx, control: { kind: 'continue' } };
      }

      // Cola de emisión por nodo (eventos del Orchestrator) en orden.
      let emitChain: Promise<void> = Promise.resolve();
      const emit = (body: unknown): void => {
        emitChain = emitChain.then(() => this.emitNode(executionId, key, body as Record<string, unknown>));
      };

      try {
        const result = await this.withTimeout(
          executor.execute({ executionId, workspaceId: this.workspaceId, nodeKey: key, config: node.config, context: baseCtx, signal: controller.signal, outgoing, emit }),
          policy.timeoutMs,
        );
        await emitChain;

        // Pausa (nodo Humano): NO se marca node.succeeded ni se completa; el nodo re-ejecutará al
        // reanudar y decidirá continuar/terminar según la revisión (re-entrada idempotente).
        if (result.control.kind === 'pause') {
          await this.deps.executions.appendLog({ executionId, nodeKey: key, stepKey, level: 'info', status: 'paused' });
          return { ok: true, nodeKey: key, context: result.context, control: result.control };
        }

        const tokens = result.usage?.tokens ?? 0;
        const cost = result.usage?.cost ?? 0;
        await this.deps.executions.appendLog({ executionId, nodeKey: key, stepKey, level: 'info', status: 'ok', tokens, cost });
        if (tokens > 0 || cost > 0) await this.deps.executions.addUsage(executionId, tokens, cost);
        // Cuota por workspace (M33): los tokens de EJECUCIÓN (agentes/router) también cuentan hacia el tope
        // diario. Best-effort: no rompe la ejecución si el contador falla.
        if (tokens > 0 && this.deps.usage) await this.deps.usage.add(this.workspaceId, tokens).catch(() => undefined);
        await this.emit(executionId, {
          type: 'node.succeeded',
          nodeKey: key,
          stepKey,
          output: result.usage ? { usage: result.usage } : undefined,
        });
        return { ok: true, nodeKey: key, context: result.context, control: result.control };
      } catch (err) {
        if (attempt < policy.maxAttempts) {
          await this.deps.executions.appendLog({ executionId, nodeKey: key, stepKey, level: 'warn', status: 'retry' });
          if (policy.backoffMs > 0) await sleep(policy.backoffMs * attempt);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        await this.deps.executions.appendLog({ executionId, nodeKey: key, stepKey, level: 'error', status: 'failed' });
        await this.emit(executionId, { type: 'node.failed', nodeKey: key, stepKey, error: message });
        return { ok: false, nodeKey: key, context: baseCtx, error: err };
      }
    }
  }

  async run(input: RunInput): Promise<string> {
    this.workspaceId = input.workspaceId;
    // M38: los pasos DESACTIVADOS se podan (puenteando sus aristas) antes de ejecutar. El resto del flujo
    // corre como si no estuvieran. Todo lo que sigue (scheduler, nodeByKey, aristas) usa el grafo ya podado.
    const graph = stripDisabledNodes(input.graph);
    const validation = validateDag(graph);
    if (!validation.valid) {
      throw new Error(`Grafo inválido: ${validation.errors.map((e) => e.code).join(', ')}`);
    }
    this.seq = Math.max(0, input.startSeq ?? 0);

    const executionId =
      input.executionId ??
      (
        await this.deps.executions.create({
          workflowVersionId: input.workflowVersionId,
          workspaceId: input.workspaceId,
          triggerType: input.triggerType,
          context: input.initialContext,
        })
      ).id;

    const resuming = (input.resumeCompleted?.length ?? 0) > 0;
    if (!resuming) await this.emit(executionId, { type: 'execution.queued' });
    await this.deps.executions.updateStatus(executionId, 'RUNNING');
    await this.emit(executionId, resuming ? { type: 'execution.status', status: 'RUNNING' } : { type: 'execution.started' });

    const scheduler = createScheduler(graph);
    const nodeByKey = new Map(graph.nodes.map((n) => [n.key, n]));
    // Aristas salientes por nodo (para que el Router inspeccione sus destinos en runtime, M14).
    const outgoingByKey = new Map<string, OutgoingEdge[]>();
    for (const n of graph.nodes) outgoingByKey.set(n.key, []);
    for (const e of graph.edges) {
      const t = nodeByKey.get(e.target);
      if (t && outgoingByKey.has(e.source) && e.source !== e.target) {
        outgoingByKey.get(e.source)!.push({ target: e.target, targetType: t.type, targetConfig: t.config, sourceHandle: e.sourceHandle ?? null });
      }
    }
    // Resume-safe: los nodos ya completados se saltan; el contexto parte del último checkpoint.
    const completed = new Set<string>(input.resumeCompleted ?? []);
    const skipped = new Set<string>(); // nodos podados por una rama/router aguas arriba (M14)
    const resolved = () => new Set<string>([...completed, ...skipped]); // terminales: desbloquean sucesores
    const controller = new AbortController();
    let ctx = resuming ? await this.deps.context.load(executionId) : input.initialContext;

    try {
      while (!scheduler.isComplete(resolved())) {
        const ready = scheduler.ready(resolved());
        if (ready.length === 0) break;

        // Partición (M14): un nodo listo se EJECUTA si tiene ≥1 arista entrante viva; si todas están
        // muertas (rama/router aguas arriba no lo eligió, o predecesor saltado) → se SALTA.
        const toRun: string[] = [];
        const toSkip: string[] = [];
        for (const key of ready) (shouldRunNode(key, graph.edges, completed, ctx) ? toRun : toSkip).push(key);

        // El skip es terminal y propaga aguas abajo (sus aristas quedan muertas en la sig. iteración).
        for (const key of toSkip) {
          await this.emit(executionId, { type: 'node.skipped', nodeKey: key });
          skipped.add(key);
        }
        if (toRun.length === 0) continue; // nivel sólo de skips: sigue con los recién desbloqueados

        const baseCtx = ctx; // copy-on-write: cada nodo del nivel parte de la misma base
        const outcomes = await Promise.all(toRun.map((key) => this.runNode(executionId, nodeByKey.get(key)!, baseCtx, outgoingByKey.get(key) ?? [], controller)));

        const failed = outcomes.find((o) => !o.ok);
        if (failed) throw failed.error;

        // Fan-in determinista: solo mezclan los nodos que produjeron contexto (no los pausados).
        const contributions: ContextContribution[] = outcomes
          .filter((o) => o.control?.kind !== 'pause')
          .map((o) => ({ nodeKey: o.nodeKey, context: o.context }));
        ctx = mergeContexts(baseCtx, contributions);
        await this.deps.context.checkpoint(executionId, ctx);
        const willPause = outcomes.some((o) => o.control?.kind === 'pause');
        // Los nodos pausados NO se marcan completados (re-ejecutan al reanudar). Si en este nivel hay
        // una PAUSA, tampoco completamos los nodos 'end': deben re-disparar su corte al reanudar; si no,
        // al reanudar quedarían saltados y la ejecución continuaría más allá del punto de terminación.
        for (const o of outcomes) {
          const k = o.control?.kind;
          if (k !== 'pause' && !(willPause && k === 'end')) completed.add(o.nodeKey);
        }

        // Suspensión por escalado humano: la ejecución queda esperando aprobación.
        if (willPause) {
          await this.deps.executions.updateStatus(executionId, 'WAITING_HUMAN');
          await this.emit(executionId, { type: 'execution.status', status: 'WAITING_HUMAN' });
          return executionId;
        }

        if (outcomes.some((o) => o.control?.kind === 'end')) break;
      }

      await this.deps.executions.updateStatus(executionId, 'SUCCEEDED');
      await this.emit(executionId, { type: 'execution.succeeded' });
      return executionId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.executions.updateStatus(executionId, 'FAILED');
      await this.emit(executionId, { type: 'execution.failed', error: message });
      throw err;
    }
  }
}
