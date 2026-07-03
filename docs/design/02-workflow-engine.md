# Diseño detallado: Motor de ejecucion de workflows (DAG)

## 1. Objetivos y principios

El motor ejecuta grafos dirigidos aciclicos (DAG) de forma **durable**, **extensible** y **desacoplada del frontend**. Principios rectores:

- **Nucleo agnostico al tipo de nodo (OCP)**: el `ExecutionScheduler` solo conoce topologia, contexto y ciclo de vida. Nunca importa un tipo de nodo concreto. Añadir un nodo = registrar un `NodeExecutor`, sin tocar el nucleo.
- **Strategy + Registry** para tipos de nodo.
- **Durabilidad primero**: todo estado relevante vive en Postgres; Redis/BullMQ son transporte y timers, no la fuente de verdad.
- **Event-sourcing ligero**: cada transicion emite un `ExecutionEvent` ordenado (seq monotono). El log alimenta WebSocket y replay.
- **Inmutabilidad del contexto** con copy-on-write para aislar ramas.

## 2. Modelo de ejecucion

### 2.1 Recorrido del DAG
El `WorkflowCompiler` produce un `CompiledGraph` con `adjacency`, `reverseAdjacency` e `indegree` por nodo. El `ExecutionScheduler` mantiene un **frontier**: un nodo es ejecutable cuando todas sus aristas entrantes activas estan satisfechas (join) o al menos una lo esta (segun `JoinMode`). El avance es dirigido por eventos: al completarse un `NodeRun`, el scheduler decrementa el indegree efectivo de sus sucesores y encola los que quedan listos.

```ts
type JoinMode = 'all' | 'any' | 'count'; // fan-in: esperar todas, cualquiera, o N ramas

interface CompiledNode {
  id: NodeId;
  type: string;                 // clave en el NodeRegistry
  config: unknown;              // validado contra configSchema
  inPorts: PortSpec[];
  outPorts: PortSpec[];
  joinMode: JoinMode;
  retry?: RetryPolicy;
  timeoutMs?: number;
  compensable: boolean;
}
```

### 2.2 Contexto y su propagacion
El contexto de negocio es inmutable:

```ts
interface ExecutionContext {
  ticket: TicketRef | null;
  repository: RepositoryRef | null;
  memory: MemoryHandle;        // acceso a memoria temporal/persistente/compartida (no se copia inline)
  variables: Readonly<Record<string, JsonValue>>;
}
```

Los nodos no mutan el contexto: devuelven un `ContextPatch` que el `ContextManager` aplica con copy-on-write, generando una nueva version.

```ts
type ContextPatch = {
  setVariables?: Record<string, JsonValue>;
  unsetVariables?: string[];
  ticket?: TicketRef;
  repository?: RepositoryRef;
  memoryOps?: MemoryOp[];       // se delegan a la capa Memory
};
```

**`memory` no se serializa inline** en cada snapshot: es un handle con clave (workflowId/agentId/scope); asi los snapshots quedan pequeños.

### 2.3 Aislamiento entre ramas
- **Fan-out**: al abrirse ramas paralelas, `ContextManager.fork(ctx, branchId)` crea un `BranchContext` que comparte estructuralmente el contexto padre (copy-on-write) pero aisla mutaciones. Cada rama tiene su `branchId`.
- **Fan-in (join)**: `ContextManager.merge(branches, policy)` fusiona segun `MergePolicy`:
  - `lastWriteWins` (por seq de finalizacion),
  - `namespacedByBranch` (variables prefijadas por branch),
  - `reducer` (funcion declarada por el nodo join).
  Los conflictos detectados emiten `context.merge_conflict` y, opcionalmente, suspenden para intervencion.

## 3. Registro de nodos extensible (SPI de plugin)

### 3.1 Interfaz `NodeExecutor` (contrato Strategy)

```ts
interface NodeExecContext {
  executionId: string;
  nodeRunId: string;
  branchId: string;
  attempt: number;
  context: ExecutionContext;    // snapshot de entrada (inmutable)
  config: unknown;              // ya validado por configSchema
  services: EngineServices;     // memory, secrets, tool-invoker, subworkflow-runner (inyectados, desacoplados)
  logger: NodeLogger;
}

type EmitFn = (evt: NodeEmit) => void; // eventos/logs/tokens/tool-calls hacia el EventLog

type NodeResult =
  | { kind: 'success'; port: string; patch?: ContextPatch }          // sale por un puerto
  | { kind: 'branch'; ports: { port: string; patch?: ContextPatch }[] } // fan-out (condicion multiple)
  | { kind: 'suspend'; signalName: string; timeoutMs?: number }       // Humano / espera de señal
  | { kind: 'wait'; delayMs: number }                                 // timer durable
  | { kind: 'fail'; error: NodeError; compensate?: boolean };

interface NodeExecutor {
  execute(input: unknown, ctx: NodeExecContext, emit: EmitFn, abort: AbortSignal): Promise<NodeResult>;
  compensate?(ctx: NodeExecContext, abort: AbortSignal): Promise<void>; // rollback opcional
}

interface NodeTypeDescriptor {
  type: string;                 // 'condition', 'agent', 'llm', 'human', ...
  version: string;
  configSchema: ZodSchema;      // se expone al editor visual y valida en compile
  inPorts: PortSpec[];
  outPorts: PortSpec[];         // p.ej. condition -> ['true','false']
  capabilities: NodeCapabilities; // { sideEffectful, deterministic, compensable, suspendable }
  factory: (deps: EngineServices) => NodeExecutor;
}
```

### 3.2 `NodeRegistry`

```ts
interface NodeRegistry {
  register(descriptor: NodeTypeDescriptor): void;
  get(type: string): NodeExecutor;
  descriptor(type: string): NodeTypeDescriptor;
  list(): NodeTypeDescriptor[]; // el editor visual y el importador consumen esto
}
```

El paquete `engine-core` **solo depende de estas interfaces**. Un test de arquitectura (ESLint `import/no-restricted-paths` o dependency-cruiser) prohibe que `engine-core` importe cualquier paquete `nodes/*`. Los nodos se registran al boot (o dinamicamente para el Marketplace) via `register()`.

### 3.3 Puertos y schema
Cada descriptor declara `inPorts`/`outPorts` (ej. `Condicion` expone `true`/`false`; `Bucle` expone `body`/`done`). El editor visual dibuja los handles a partir de esto. `configSchema` (Zod) sirve para: (a) validar en `compile`, (b) generar el formulario de config en el frontend, (c) validar en runtime antes de `execute`.

## 4. Soporte de estructuras de control

| Estructura | Mecanismo |
|---|---|
| **Condiciones/ramas** | `NodeResult.kind='success'` con `port`; o `kind='branch'` para fan-out multiple. |
| **Paralelismo** | Multiples sucesores listos se encolan simultaneamente; el Worker los procesa concurrentemente. |
| **Join/fan-in** | `joinMode` del nodo + `MergePolicy` en `ContextManager.merge`. |
| **Esperas (timers)** | `kind='wait'` -> `TimerService` (BullMQ delayed job + tabla Timer). |
| **Reintentos + backoff** | `RetryPolicy { maxAttempts, backoff: 'exp', baseMs, jitter }`; el delay entre intentos usa `TimerService`. |
| **Timeouts** | `AbortController` con `timeoutMs`; al vencer, `abort` se dispara y el executor debe cancelar. |
| **Rollbacks/compensacion** | `CompensationManager` (saga LIFO) invoca `compensate()` de los `NodeRun` completados. |
| **Pausas manuales (Humano)** | `kind='suspend'` + `SignalGateway`; se resuelve via endpoint inbound. |
| **Errores** | `kind='fail'` -> politica del nodo/workflow: fail-fast, aislar rama, o compensar. |
| **Subworkflows** | Executor especial que lanza una `Execution` hija y espera su señal de fin. |

```ts
interface RetryPolicy { maxAttempts: number; backoff: 'fixed'|'exp'; baseMs: number; jitter: boolean; retryOn?: string[]; }
```

## 5. Ejecucion durable sobre BullMQ

### 5.1 Colas
- `node-run`: procesa un `NodeRun` (unidad de trabajo).
- `timers`: delayed jobs para esperas/backoff/timeouts.
- `compensation`: ejecuta sagas de rollback.

### 5.2 Ciclo del Worker (idempotente)

```ts
async process(job: Job<NodeRunPayload>) {
  const run = await repo.claimNodeRun(job.data.nodeRunId, job.data.idempotencyKey);
  if (run.status === 'completed') return; // idempotencia: ya procesado (resume/reintento)
  const abort = new AbortController();
  const timer = timers.armTimeout(run, abort);
  try {
    const executor = registry.get(run.type);
    const result = await executor.execute(run.input, buildCtx(run), emit, abort.signal);
    await repo.tx(async t => {                 // outbox transaccional
      await t.upsertNodeRun(run, result);       // estado + output
      await t.appendLog(collectedEvents);       // eventos en la misma tx
    });
    scheduler.onNodeCompleted(run, result);
  } catch (e) { await handleFailureWithRetry(run, e); }
  finally { timer.clear(); }
}
```

**Claves de durabilidad:**
- **idempotencyKey** deterministico = `hash(executionId, nodeId, branchId, attempt)`. `claimNodeRun` es un upsert condicional; si el job se reentrega tras caida, no se reejecuta un `NodeRun` ya `completed`.
- **Outbox transaccional**: NodeRun + eventos se persisten en una sola transaccion Postgres; asi el estado y su log nunca divergen.
- **Resume tras caida**: al arrancar, `ExecutionRepository.loadResumableState(executionId)` reconstruye el frontier desde los `NodeRun` no terminales y el `indegree` efectivo; los timers se reconcilian desde la tabla `Timer`. BullMQ reentrega jobs `active` huerfanos (stalled).
- **Cancelacion**: `CancellationController.cancel(executionId)` marca `cancelRequested`, dispara `abort` en ramas activas, drena timers y jobs pendientes; es idempotente.

### 5.3 Exactly-once vs at-least-once
El motor garantiza **at-least-once en la entrega del job + exactly-once en la transicion de estado** (via idempotencyKey + outbox). Para side-effects externos no idempotentes, los `NodeExecutor` con `capabilities.sideEffectful=true` deben deduplicar por `idempotencyKey` (contrato obligatorio) o ser tratados como no-reejecutables en replay.

## 6. Contrato con persistencia y stream de eventos

### 6.1 `ExecutionRepository`

```ts
interface ExecutionRepository {
  createExecution(input: CreateExecution): Promise<Execution>;
  claimNodeRun(nodeRunId: string, idempotencyKey: string): Promise<NodeRun>;
  upsertNodeRun(run: NodeRun, result: NodeResult): Promise<void>;
  appendLog(events: ExecutionEvent[]): Promise<void>; // append-only, seq monotono
  saveSnapshot(snap: ContextSnapshot): Promise<ContextSnapshotRef>;
  loadResumableState(executionId: string): Promise<ResumeState>;
  tx<T>(fn: (t: TxRepo) => Promise<T>): Promise<T>;
}
```

### 6.2 `ExecutionEvent` (fuente unica de WebSocket + replay)

```ts
interface ExecutionEvent {
  executionId: string;
  seq: number;                  // monotono por execution -> orden total para replay
  ts: string;
  schemaVersion: number;        // versionado para replays antiguos
  nodeRunId?: string;
  type: 'execution.started' | 'node.scheduled' | 'node.started' | 'node.log'
      | 'node.tool_call' | 'node.llm_response' | 'node.tokens' | 'context.patched'
      | 'node.completed' | 'node.failed' | 'node.suspended' | 'node.resumed'
      | 'node.retry' | 'context.merge_conflict' | 'compensation.run'
      | 'execution.completed' | 'execution.failed' | 'execution.cancelled';
  payload: JsonValue;
}
```

El `EventEmitter` escribe en `ExecutionLog` (tx del outbox) y publica en Redis Stream `exec:{executionId}`. El **WebSocket Gateway** se suscribe al stream y reenvia a los clientes. El observabilidad (tokens, costo, tool-calls, prompts) viaja como eventos `node.*` sin acoplar el nucleo a esos conceptos.

### 6.3 Replay determinista
`ReplayEngine.replay(executionId)` lee `ExecutionLog` en orden de `seq` y `ContextSnapshot` por `NodeRun`, reproduciendo cada paso **sin reejecutar side-effects** (modo `dry`: los outputs registrados se reproducen tal cual). Para nodos `deterministic=true` se puede opcionalmente reejecutar. `schemaVersion` permite adaptar eventos antiguos.

## 7. Consideraciones de escalabilidad
- Concurrencia por Worker configurable + fairness multi-tenant (colas o rate-limit por Organization) para miles de ejecuciones simultaneas.
- Snapshots por **delta** (`ContextPatch`) y payloads grandes en blob store referenciados por `ref`.
- Limites por Execution (`maxNodeRuns`, `maxDepth`, `maxLoopIterations`) validados en compile y enforced en runtime.

## 8. Ejemplo: NodeExecutor de Condicion (plugin, sin tocar el nucleo)

```ts
const conditionDescriptor: NodeTypeDescriptor = {
  type: 'condition', version: '1.0.0',
  configSchema: z.object({ expression: z.string() }), // ej. "ctx.variables.score > 0.8"
  inPorts: [{ name: 'in' }],
  outPorts: [{ name: 'true' }, { name: 'false' }],
  capabilities: { sideEffectful: false, deterministic: true, compensable: false, suspendable: false },
  factory: (deps) => ({
    async execute(_input, ctx, emit) {
      const ok = deps.expr.eval(ctx.config.expression, ctx.context);
      emit({ type: 'node.log', message: `condition=${ok}` });
      return { kind: 'success', port: ok ? 'true' : 'false' };
    },
  }),
};
registry.register(conditionDescriptor); // el motor lo descubre sin cambios en engine-core
```

Este patron demuestra la extensibilidad exigida: un tipo de nodo nuevo aporta su `configSchema`, sus puertos y su logica; el nucleo lo orquesta a traves de la interfaz sin conocerlo.
