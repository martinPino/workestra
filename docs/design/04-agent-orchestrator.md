# Deep-Dive Final: Sistema de Agentes + Orchestrator

> **Área PRIORITARIA (Prioridad 2 del usuario).** Objetivo: pasar de "un nodo Agente ejecutable" a "un Orchestrator multi-agente completo", extensible por plugins, respetando SOLID / Clean Architecture. **El Orchestrator NUNCA resuelve tareas técnicas: solo coordina.**
>
> Este documento es autocontenido. Incorpora las correcciones de las tres lentes de crítica (sequencing, completeness, priority-derisking). Los cambios estructurales más importantes frente al diseño base son cuatro:
> 1. **Contrato de eventos y `ExecutionStateReducer` puros y congelados desde el inicio** (no en una fase tardía de observabilidad).
> 2. **Walking skeleton del Orchestrator temprano**: un slice vertical `Planner → validador → PlanExecutor secuencial` desacoplado del motor durable completo, para de-riesgar el mayor riesgo de P2 (que el LLM genere planes inválidos) semanas antes.
> 3. **Puerto `MemoryStore` y RBAC mínimo presentes desde el nacimiento del `AgentRuntime`**, no diferidos.
> 4. **Restricción explícita de herramientas peligrosas** hasta que exista sandbox: el Orchestrator no se de-riesga corriendo Git/Filesystem sin aislamiento.

---

## 1. Principios de diseño

- **Clean Architecture por capas.**
  - `dominio`: `AgentSpec`, `Plan`, `ExecutionEvent`, `ExecutionStateReducer`, políticas y presupuestos. **Cero** dependencias de infraestructura, **cero** no-determinismo (prohibido `Date.now()`, `Math.random()`, IO).
  - `aplicación`: `AgentRuntime`, `Orchestrator`, `PlanExecutor`, casos de uso.
  - `infraestructura`: adapters `LLMProvider`, plugins `ToolPlugin`, Prisma, Redis, BullMQ, pgvector.
- **Inversión de dependencias.** El runtime depende de interfaces (`LLMProvider`, `ToolPlugin`, `MemoryStore`, `Clock`, `IdGenerator`), nunca de implementaciones concretas. Se resuelven por registro / DI de NestJS.
- **Open/Closed por plugins.** Añadir un modelo, una herramienta, una estrategia de selección o un guardrail NO modifica el núcleo; se registra en su `Registry`. Añadir un tipo de nodo tampoco toca el motor (ver §8).
- **Uniformidad Agent/Orchestrator.** Ambos implementan `AgentRuntime`; el motor los trata igual como nodos. El Orchestrator es "un agente cuyo output es un `Plan`".
- **Event log append-only como única fuente de verdad — desde el primer día.** Todo estado observable (del agente y del plan) se deriva reproduciendo eventos con un **reducer puro compartido cliente/servidor**. Todo efecto no determinista (semillas, timestamps, salidas de herramienta, orden de tool-calls) se **graba como evento** en el momento en que ocurre. Esto es un principio arquitectónico, no una feature de una fase tardía.
- **Seguridad transversal, no opcional.** RBAC mínimo, deny-by-default de herramientas y auditoría existen desde que hay algo que autorizar. Las capacidades peligrosas (Git, Filesystem, infra) no se exponen antes de existir su aislamiento.

---

## 2. Contrato de eventos y reducer determinista (fundacional)

> **Corrección de crítica (sequencing/high, M6 y M1).** El diseño base dejaba el reducer y el contrato completo de eventos para la fase de observabilidad, contradiciendo el principio "event log como fuente de verdad desde M1". Aquí el contrato es un **artefacto de primera clase, versionado y congelado desde el inicio**. Los emisores nacen correctos; la fase de observabilidad solo añade proyecciones/UI, nunca rediseña el contrato.

### 2.1 `ExecutionEvent` (append-only, versionado)

```ts
interface ExecutionEvent<T extends EventType = EventType> {
  schemaVersion: number;        // versionado del contrato; se migra, nunca se rompe en silencio
  seq: number;                  // orden total monotónico por ejecución (asignado por el store)
  executionId: string;
  nodeId: string;               // nodo estático o subtarea (nodo Agente hijo) que emite
  runId: string;                // reintento/instancia; distingue re-ejecuciones del mismo nodo
  parentNodeId?: string;        // para sub-DAG del Orchestrator: nodo Orchestrator padre
  type: T;
  payload: EventPayload[T];
  recordedAt: string;           // timestamp GRABADO (no leído del reloj en replay)
  causationId?: string;         // evento que causó este (p. ej. el tool-call que produjo el result)
}
```

**Regla de determinismo (verificada por lint + test):** el reducer y el dominio no pueden llamar a `Date.now()`, `Math.random()`, `crypto.randomUUID()` ni a ninguna fuente de IO. Todo lo no determinista entra como `payload` de un evento (semillas de sampling del LLM, `recordedAt`, `toolResult` completo, orden real de tool-calls). Un `Clock` e `IdGenerator` inyectados producen esos valores **una sola vez** en el emisor, que los graba en el evento; el replay los lee del evento.

### 2.2 Taxonomía mínima de eventos (congelada, extensible por unión discriminada)

| Categoría | Eventos |
|---|---|
| Nodo/ejecución | `NodeStarted`, `NodeCompleted`, `NodeFailed`, `NodeRetried`, `NodePaused`, `NodeResumed` |
| Agente | `AgentPromptBuilt` (prompt final + refs de memoria usadas), `AgentTextDelta`, `AgentToolCallRequested`, `AgentToolCallResult`, `AgentUsage`, `AgentCompleted` |
| Herramientas | `ToolAuthDecision` (allow/deny/require-human + razón), `ToolInvocationStarted`, `ToolInvocationResult` |
| Memoria | `MemoryRead`, `MemoryAppended` (scope, key, hash del contenido) |
| Plan/Orchestrator | `PlanCreated`, `PlanValidationFailed`, `PlanDelta`, `SubtaskDispatched`, `SubtaskStatusChanged`, `SubtaskResult`, `ResultsMerged` |
| Presupuesto | `BudgetReserved`, `BudgetConsumed`, `BudgetExceeded` |
| Humano | `HumanReviewRequested`, `HumanReviewResolved`, `HandoffPerformed` |

### 2.3 `ExecutionStateReducer` (puro, compartido cliente/servidor)

```ts
// Determinista: mismos eventos ⇒ mismo estado. Sin IO, sin reloj, sin azar.
function executionReducer(state: ExecutionState, event: ExecutionEvent): ExecutionState;

interface ExecutionState {
  nodes: Record<NodeId, NodeRunState>;      // status, intentos, timings grabados
  plan?: PlanState;                          // árbol de subtareas del Orchestrator
  budget: BudgetState;                       // tokens/coste/llamadas acumulados
  memoryTouches: MemoryTouch[];              // para replay que reconstruye memoria
  humanGates: HumanGateState[];
}
```

- El **mismo** reducer alimenta la consola en vivo (aplicando eventos que llegan por WebSocket) y el **replay** (reproduciendo el log persistido). No hay dos verdades.
- **Replay que reconstruye memoria** (corrección completeness, M7): como `MemoryRead`/`MemoryAppended` están en el log desde el nacimiento del `MemoryStore`, el reducer reconstruye qué vio y escribió cada agente sin re-tocar la implementación de replay más adelante.
- **Definición de Done fundacional:** existe un test property-based que verifica `reducer(events) === reducer(events)` (idempotencia de proyección) y que el estado es invariante bajo re-emisión desde snapshot.

---

## 3. Abstracción Agent y registro

### 3.1 `AgentSpec` (dominio)

```ts
interface AgentSpec {
  id: string;
  version: number;
  name: string;
  description: string;
  systemPrompt: string;
  modelRef: string;                 // p. ej. "openai:gpt-5" o "anthropic:claude-opus-4"
  toolRefs: string[];               // herramientas AUTORIZADAS (allowlist)
  memory: MemoryConfig;             // scopes habilitados + política de conversación (§7)
  variables: Record<string, unknown>;
  limits: BudgetLimits;             // presupuesto duro
  permissions: AgentPermissions;    // RBAC + scopes de secretos
  tags?: string[];                  // capabilities para AgentSelectionStrategy
}

interface BudgetLimits {
  maxTokens?: number; maxCost?: Money; maxWallClockMs?: number;
  maxToolCalls?: number; maxIterations?: number;
}
```

**Persistencia:** `agents` (identidad) + `agent_versions` (contenido inmutable versionado). Publicar una definición crea una `AgentVersion`; **las ejecuciones referencian una versión concreta** para reproducibilidad (igual que `WorkflowVersion`). Esto habilita el pin de versión por ejecución que exige la crítica de completeness.

### 3.2 `AgentRegistry`

```ts
interface AgentRegistry {
  get(id: string, version?: number): Promise<AgentSpec>;
  list(workspaceId: string): Promise<AgentSummary[]>;
  create(spec: DraftAgentSpec): Promise<AgentSpec>;
  publishVersion(id: string, spec: DraftAgentSpec): Promise<AgentSpec>;
  validate(spec: DraftAgentSpec): ValidationResult; // tools existen, modelo disponible, permisos coherentes
}
```

---

## 4. Abstracción de MODELO (LLM) desacoplada

> **Corrección (sequencing/low, M5).** Esta capa es **independiente del editor y del compilador** y puede desarrollarse en un track paralelo desde el inicio. Se formaliza como sub-hito propio (ver §12) para que el camino crítico no la esconda dentro del hito de runtime de agentes.

Toda dependencia de proveedor vive detrás de una interfaz única. Tool-calling, streaming y usage se normalizan en el adapter.

```ts
interface LLMProvider {
  id: string;                       // "openai", "anthropic", ...
  capabilities: ModelCapabilities;  // { toolCalling, streaming, jsonMode, maxContext }
  complete(req: LLMRequest): AsyncIterable<LLMChunk>;
  countTokens(messages: LLMMessage[], modelRef: string): number;
}

interface LLMRequest {
  modelRef: string;
  messages: LLMMessage[];
  tools?: ToolSchema[];             // JSON-Schema de las herramientas autorizadas
  toolChoice?: 'auto' | 'none' | { name: string };
  temperature?: number; maxTokens?: number; stream: boolean;
  seed?: number;                    // GRABADO en evento para replay determinista del sampling
  responseFormat?: 'text' | { jsonSchema: JSONSchema }; // salida estructurada (planes)
}

type LLMChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; id: string; name: string; argsDelta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'error' };
```

- **`ModelRegistry` / `LLMRouter`**: resuelve `modelRef → ResolvedModel`, aplica fallback/failover, rate-limiting y selección por coste. `CostCalculator.cost(usage, modelRef)` usa un `ModelCatalog` de precios versionado (grabado en el evento `AgentUsage` para que el coste sea reproducible aunque cambien las tarifas).
- **Extensibilidad:** un nuevo proveedor es un plugin que implementa `LLMProvider`. Un `MockLLMProvider` **determinista** (respuestas guionizadas por hash del prompt) habilita tests y, sobre todo, el **dry-run** de workflows (§11).

---

## 5. `AgentRuntime` (nodo Agente ejecutable)

```ts
interface AgentRuntime {
  getKind(): 'agent' | 'orchestrator';
  execute(input: AgentInput, ctx: ExecutionContext): AsyncIterable<AgentEvent>;
}

interface AgentInput { task: Task; spec: AgentSpec; }
interface ExecutionContext {
  executionId: string; nodeId: string; runId: string; workspaceId: string;
  context: { ticket?: unknown; repository?: unknown; memory: MemoryStore; variables: Record<string, unknown> };
  budget: BudgetManager;
  emitter: ObservabilityEmitter;    // única vía de salida: TODO efecto observable se emite como ExecutionEvent
  clock: Clock; ids: IdGenerator;   // fuentes de no-determinismo inyectadas y grabadas
  authz: AuthorizationContext;      // RBAC del workspace + scopes de secretos
}
```

Bucle interno del `DefaultAgentRuntime`:

1. **Construir prompt:** `systemPrompt` + recuperación de memoria (`memory.searchSemantic`) + historial de conversación gestionado por ventana (§7) + variables + task. Emitir `AgentPromptBuilt` (prompt final + refs de memoria).
2. **`budget.reserve(estimate)`**; llamar `LLMProvider.complete` en streaming, emitiendo `AgentTextDelta`. La `seed` usada se graba.
3. **Tool-calls:** por cada uno, `ToolAuthorizationService.authorize(...)` (deny-by-default) → si `Allow`, `ToolInvoker.call(...)` → añadir resultado al hilo. Emitir `ToolAuthDecision`, `ToolInvocationStarted`, `ToolInvocationResult` (resultado **completo** grabado, requisito de replay).
4. **Repetir** hasta `finish=stop` o hasta `limits.maxIterations`/presupuesto. `budget.consume(usage)` en cada paso.
5. **Escribir memoria** efímera/persistente (emitiendo `MemoryAppended`) y emitir `AgentCompleted` con el resultado normalizado.

> **Nota de determinismo:** el runtime nunca lee el reloj ni genera ids directamente; usa `clock`/`ids`, cuyos valores viajan en los eventos. Así el replay es bit-a-bit reproducible.

---

## 6. Autorización de herramientas, guardrails y presupuesto

```ts
interface ToolPlugin {
  name: string;
  paramsSchema: JSONSchema;
  dangerLevel: 'safe' | 'sandboxed' | 'privileged'; // clasificación explícita
  invoke(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolAuthorizationService {
  authorize(spec: AgentSpec, call: ToolCall, ctx: ExecutionContext): AuthDecision; // Allow | Deny(reason) | RequireHuman
}
```

- **Gate deny-by-default.** Cruza: `spec.toolRefs` (allowlist) ∩ **RBAC del workspace** ∩ scopes del `Secret` requerido. Cada `AuthDecision` se audita (`ToolAuthDecision`).
- **RBAC mínimo desde el inicio** (corrección completeness/high, M10). El gate consume roles reales (`owner/admin/editor/viewer` + scopes por recurso) desde que el runtime existe, no un stub. Los roles custom/ABAC avanzados llegan después, pero el *punto de extensión* nace correcto.
- **Restricción de herramientas peligrosas hasta existir sandbox** (corrección priority-derisking/medium, M8). Mientras no haya aislamiento real (`isolated-vm` / contenedor efímero + allowlist de red/fs), las herramientas `privileged`/`sandboxed` (Git, Filesystem, Docker, infra) están **bloqueadas por política** para runtimes y Orchestrator; solo se permiten `safe` (HTTP a allowlist, Mock). Esta restricción se documenta en el scope de las fases tempranas: **el Orchestrator se de-riesga sin correr Git/Filesystem sin aislamiento.**
- **Guardrails** como cadena de responsabilidades: `Guardrail.check(stage, payload, ctx)` en `input` / `output` / `toolArgs` (PII, jailbreak, formato). Pluggable.
- **`BudgetManager`:** `reserve` / `consume` / `assertWithinLimits`; al exceder aborta o eleva `RequireHuman`. Límites en tres niveles: **agente**, **plan** (agregado de subtareas del Orchestrator) y **ejecución** (tope global del workflow). El nivel "plan" es clave para que un Orchestrator no dispare coste ilimitado fan-out.

---

## 7. Memoria

> **Corrección (sequencing/completeness, M7).** El **puerto `MemoryStore` y un backend persistente básico existen desde el nacimiento del `AgentRuntime`**, y la memoria **emite eventos al log desde el inicio**, para que el handoff/context-slicing del Orchestrator y el replay se construyan sobre el puerto correcto. Lo que se difiere es solo el backend **vector/semántico** y las **políticas de retención** — no el puerto ni la emisión de eventos.

```ts
type MemoryScope = 'ephemeral' | 'agent-persistent' | 'workflow-shared';

interface MemoryStore {
  read(scope: MemoryScope, key: string): Promise<MemoryEntry[]>;
  append(scope: MemoryScope, entry: MemoryEntry): Promise<void>;      // emite MemoryAppended
  searchSemantic(scope: MemoryScope, query: string, k: number): Promise<MemoryEntry[]>; // emite MemoryRead
}
```

- **`ephemeral`** (por ejecución): Redis con TTL. **`agent-persistent`** y **`workflow-shared`**: Postgres; búsqueda semántica sobre `pgvector` (backend diferido, interfaz estable).
- **Memoria compartida entre subtareas paralelas:** política de **locking/merge** explícita (last-write-wins con versión, o CRDT append-only para logs). El Orchestrator escribe hallazgos en `workflow-shared`; los agentes hijos leen bajo lock optimista.
- **Memoria conversacional del agente** (corrección completeness/medium, M7): política de **ventana de contexto** — truncado + **resumen incremental** (compactación de historial largo vía un `summarize` del propio modelo) + **anclaje de mensajes clave** (system, decisiones del plan). Evita que agentes de larga duración desborden el contexto. El resumen se graba como `MemoryAppended` para ser reproducible.

---

## 8. ORCHESTRATOR (agente líder)

El Orchestrator implementa `AgentRuntime` pero **su única salida es un `Plan`** y decisiones de coordinación. **No ejecuta trabajo técnico.**

```ts
interface Orchestrator extends AgentRuntime {
  plan(task: Task, ctx: ExecutionContext): Promise<Plan>;
  onSubtaskResult(sub: Subtask, result: SubtaskResult, state: PlanState): PlanDelta;
}

interface Plan { id: string; subtasks: Subtask[]; edges: Dependency[]; }  // DAG
interface Subtask {
  id: string; description: string;
  assignedAgentId: string; assignedAgentVersion: number; // pin de versión
  dependsOn: string[]; status: SubtaskStatus;
  budget?: BudgetLimits;    // sub-presupuesto por subtarea
}
```

### 8.1 Bucle de coordinación

```
analizar tarea
  → planificar (Planner + LLM con responseFormat=jsonSchema)
  → validar Plan (aciclicidad, agentes/tools existen, presupuesto factible)
  → seleccionar agentes (AgentSelectionStrategy)
  → despachar (PlanExecutor materializa sub-DAG)
  → esperar
  → resolver dependencias (DAG: readiness = deps satisfechas)
  → fusionar resultados (ResultsMerged)
  → manejar errores/reintentos (por subtarea, con presupuesto de reintento)
  → escalar al usuario (RequireHuman / HumanEscalation)
```

```ts
interface Planner { buildPlan(task: Task, available: AgentSummary[], ctx): Promise<Plan>; }
interface AgentSelectionStrategy { select(sub: Subtask, candidates: AgentSummary[]): AgentSpec; } // capabilities/tags/coste/permisos
```

### 8.2 Validación de Plan (el riesgo #1 de P2, de-riesgado temprano)

> **Corrección (priority-derisking/high, M5).** El mayor riesgo del Orchestrator es *"el LLM produce planes inválidos/cíclicos/no ejecutables"*. Ese riesgo es de **generación + validación estructurada** y **no requiere el motor durable completo**. Por eso el `Planner` + validador + re-prompt acotado se prototipan **en cuanto existe `LLMProvider` con salida estructurada**, medidos contra un set de tareas reales, y **no** detrás del motor durable.

Validaciones, en orden, antes de ejecutar:
1. **Aciclicidad** del DAG (`edges` no forman ciclo).
2. **Referencias válidas:** cada `assignedAgentId`/`toolRef` existe y está autorizado en el workspace (RBAC).
3. **Presupuesto factible:** suma de sub-presupuestos ≤ presupuesto de plan.
4. **Alcanzabilidad:** toda subtarea es alcanzable desde el inicio y contribuye al resultado.

En fallo: **re-prompt acotado** con el error concreto (`PlanValidationFailed` grabado). Tras **N** intentos, **escalar a humano** en vez de bucle infinito.

### 8.3 Representación observable del plan

- El `Plan` se persiste (`plans`, `subtasks`) y se emite `PlanCreated` / `PlanValidationFailed` / `PlanDelta` / `SubtaskStatusChanged` por WebSocket.
- El reducer (§2.3) proyecta el **árbol de subtareas** en vivo. La **observabilidad básica del Plan es co-requisito de de-riesgar el Orchestrator** (corrección priority-derisking/medium, M6): desde el walking skeleton se dispone del event log del plan y de la vista de árbol de subtareas, aunque el scrubber time-travel completo llegue con la consola de observabilidad.

---

## 9. Integración con el MOTOR: sub-DAG dinámico

El Orchestrator **no ejecuta** subtareas por sí mismo. **`PlanExecutor` materializa el `Plan` como un sub-DAG dinámico** y lo entrega al motor, que corre cada subtarea como un **nodo Agente hijo** reutilizando exactamente la misma maquinaria (reintentos, timeouts, paralelismo, pausas, observabilidad, replay) que los nodos estáticos.

```ts
interface PlanExecutor {
  materialize(plan: Plan, parentCtx: ExecutionContext): SubGraph; // nodos Agente hijos + edges
  onEvents(sub: Subtask, cb: (e: AgentEvent) => void): void;
}
```

- El nodo **Agente** en el canvas ejecuta un `AgentSpec` fijo. El nodo/modo **Orchestrator** ejecuta el bucle anterior y **expande un sub-DAG en runtime**.
- **Ventaja arquitectónica:** el motor **no conoce "multi-agente"**; solo ejecuta nodos. Toda la inteligencia vive en el Orchestrator/PlanExecutor → extensible y observable sin acoplar el núcleo. Añadir un tipo de nodo o una estrategia no toca el motor (Open/Closed).
- **Dos modos de `PlanExecutor`** (corrección priority-derisking/high, M5):
  - **`SequentialPlanExecutor`** (walking skeleton): materializa y ejecuta el sub-DAG sobre el **scheduler secuencial** temprano, sin durabilidad ni paralelismo avanzado. Valida la mecánica `plan → sub-DAG` semanas antes del motor durable.
  - **`DurablePlanExecutor`** (endurecimiento): reutiliza fan-out/fan-in, resume, timers e **idempotencia/outbox** del motor durable. Es el mismo contrato `PlanExecutor`; solo cambia la política de despacho y durabilidad.
- **Contrato de scheduler pensado para concurrencia desde el inicio** (corrección sequencing/medium, M1): expone *"nodos listos"* como **conjunto** (readiness por dependencias satisfechas), no como *siguiente-único*. El paso a durable cambia la **política de despacho**, no el contrato. El `SequentialPlanExecutor` ejecuta de uno en uno, pero consulta el mismo conjunto de readiness que usará el paralelo.

---

## 10. Escalado a humano y handoff

```ts
interface HumanEscalation { requestReview(ctx, question: string, options?: string[]): Promise<PendingReview>; }
interface HandoffService { handoff(from: AgentSpec, to: AgentSpec, slice: ContextSlice): Task; }
```

- El **nodo Humano** suspende la ejecución: persiste el estado (derivable del log) y encola un job BullMQ pausado; al recibir respuesta por `WS /executions/{id}/human`, reanuda (`HumanReviewResolved`). Estados `blocked` / `wait_for_review` visibles y ordenados en la consola.
- **Disparadores de escalado:** presupuesto excedido, `RequireHuman` de una `AuthDecision`, N fallos de validación de Plan, o baja confianza declarada por el Orchestrator.
- **Handoff** agente→agente pasa un **`ContextSlice` acotado** (política de context-slicing) para controlar coste/privacidad. El handoff se graba (`HandoffPerformed`) y es reproducible en replay.
- **SLA de aprobación humana** (gancho para alerting de plataforma): si una revisión queda `blocked` más allá de un umbral, se notifica al owner (email/Slack/webhook).

---

## 11. Observabilidad, replay y dry-run

- **`AgentEvent`/`ExecutionEvent`** (unión tipada, §2) cubre: prompt usado, `text-delta`, tool-calls y resultados completos, uso de memoria, `usage` (tokens/coste), y decisiones del plan. Se emite por WebSocket y se persiste en `ExecutionLog`.
- **Replay determinista** paso a paso de una ejecución multi-agente = re-alimentar el log al `ExecutionStateReducer`. Reconstruye estado del plan, del agente **y de la memoria** (porque la memoria emite eventos desde el inicio).
- **Dry-run / simulación** (corrección completeness/high — requisito TESTING). Ensayar un workflow **nuevo** sin efectos reales: mismo motor, con `ToolInvoker` en **modo mock** (fixtures del usuario) y `MockLLMProvider` determinista, datos de entrada de ejemplo y **asserts** sobre el resultado. Reutiliza toda la maquinaria; el dry-run es "una ejecución con adapters mock", no un camino de código separado.

---

## 12. APIs

- **REST:** `POST/GET /agents`, `POST /agents/{id}/validate`, `POST /executions`, `GET /executions/{id}`, `GET /executions/{id}/plan`, `POST /executions/{id}/dry-run`, `POST /tools`, `POST /models`.
- **WebSocket:** `/executions/{id}/stream` (`ExecutionEvent` en vivo, consumido por el reducer), `/executions/{id}/human` (respuestas de escalado).
- **SPI de plugins:** `LLMProvider`, `ToolPlugin`, `AgentSelectionStrategy`, `Guardrail`, `MemoryStore` (backend).

---

## 13. Mini-plan de fases específico del Orchestrator

> Reordenado según las tres lentes: contrato de eventos y RBAC mínimo **primero**; **walking skeleton de P2 temprano** (desacoplado del motor durable); memoria como puerto desde el inicio; herramientas peligrosas gateadas hasta sandbox; observabilidad básica del plan como co-requisito, no fase posterior. Las fases O1–O3 pueden correr en un **track paralelo** que arranca en cuanto existe `LLMProvider`, mientras otro equipo endurece el motor durable.

| Fase | Contenido | Depende de | De-riesga |
|---|---|---|---|
| **O0 — Cimientos deterministas** | `ExecutionEvent` versionado + `ExecutionStateReducer` puro compartido, congelados. Lint/test que prohíben no-determinismo en dominio. `Clock`/`IdGenerator` inyectados. RBAC mínimo (owner/admin/editor/viewer). | Contrato de motor base | El riesgo #1 de sequencing: reescribir el contrato de eventos en una fase tardía. |
| **O1 — Capa LLM** *(track paralelo)* | `LLMProvider` + `ModelRegistry`/`LLMRouter` + `CostCalculator` + adapters (OpenAI/Anthropic) + `MockLLMProvider` determinista. Salida estructurada (`jsonSchema`). | O0 | Fiabilidad de tool-calling/streaming/coste; habilita mocks y dry-run. |
| **O2 — AgentRuntime + puertos** | `DefaultAgentRuntime` (bucle prompt→tool→memoria), puerto `MemoryStore` con backend persistente básico **emitiendo eventos**, `ToolAuthorizationService` deny-by-default sobre RBAC. Solo herramientas `safe`. | O0, O1 | Nodo Agente ejecutable observable; memoria en el log desde el inicio. |
| **O3 — Walking skeleton Orchestrator** | `Planner` + **validador de Plan** (aciclicidad/refs/presupuesto) + re-prompt acotado + `SequentialPlanExecutor` sobre scheduler secuencial. Vista de árbol de subtareas + event log del plan. | O2 | El riesgo #1 de P2 (LLM→Plan inválido) validado **temprano**, sin motor durable. |
| **O4 — Guardrails + presupuesto** | Cadena de `Guardrail`, `BudgetManager` a nivel agente/plan/ejecución, `RequireHuman` por límite. | O2 | Coste descontrolado y salidas inseguras antes de exponer más capacidad. |
| **O5 — Orchestrator durable** | `DurablePlanExecutor` sobre motor durable (fan-out/fan-in, resume, timers, idempotencia/outbox). Reintentos por subtarea. `AgentSelectionStrategy` pluggable. | O3, motor durable | Endurecimiento del sub-DAG: paralelismo/resume, sin rehacer la mecánica del plan. |
| **O6 — Memoria avanzada** | Backend vector/semántico (`pgvector`), `workflow-shared` con locking/merge, memoria conversacional (ventana/resumen/anclaje), retención. | O2, O5 | Handoff y shared-memory reales sobre el puerto ya existente. |
| **O7 — Escalado/handoff + sandbox** | `HumanEscalation`, `HandoffService` + context-slicing, **sandbox** (`isolated-vm`/contenedor) que **desbloquea herramientas `privileged`**. SLA de aprobación + alerting al owner. | O3, O5, gate de tools | Ejecutar tools peligrosas **con** aislamiento; recuperación multi-agente. |
| **O8 — Dry-run + replay integral** | Modo simulación (`ToolInvoker` mock + `MockLLMProvider` + asserts), scrubber time-travel, snapshots. | O0, O2, O3 | TESTING de workflows del usuario + depuración multi-agente reproducible. |

**Camino crítico de P2:** O0 → O1 → O2 → **O3 (slice usable del Orchestrator)** → O5. Las fases O4, O6, O7, O8 cuelgan de O2/O3 y pueden solaparse. El slice usable del Orchestrator (O3) llega **antes** del motor durable completo, alineando la realidad con el principio "de-riesgar P2 pronto".

---

### Resumen de correcciones incorporadas

- **Contrato de eventos + reducer puro congelados en O0** (no en fase de observabilidad) — resuelve la contradicción "fuente de verdad desde M1" y el re-trabajo de emisores.
- **Walking skeleton del Orchestrator (O3) desacoplado del motor durable** — de-riesga el mayor riesgo de P2 semanas antes; slice usable temprano.
- **Validación LLM→Plan prototipada en cuanto hay `LLMProvider`** — el riesgo existencial de P2 se valida temprano, no a mitad de proyecto.
- **`MemoryStore` como puerto y con eventos desde O2** — replay reconstruye memoria sin re-tocar el motor de replay; handoff sobre puerto correcto.
- **RBAC mínimo desde O0** — el gate de herramientas consume roles reales, no un stub.
- **Herramientas peligrosas gateadas por `dangerLevel` hasta sandbox (O7)** — el Orchestrator no se de-riesga corriendo Git/Filesystem sin aislamiento.
- **Scheduler con readiness como conjunto desde el inicio** — durable solo cambia política de despacho, no el contrato.
- **Observabilidad básica del plan como co-requisito de O3**, dry-run como modo del propio motor (O8) — cubre TESTING y depuración multi-agente.
- **Capa LLM como track paralelo (O1)** — no queda escondida en el camino crítico serial.
