# Observabilidad, Replay y Sistema de Memoria — Documento de Diseño

## 0. Alcance y principios

Este documento diseña tres subsistemas que comparten un mismo eje (la ejecución de un workflow) pero se mantienen **desacoplados por puertos** (interfaces de dominio):

1. **Telemetría event-sourced** — la ejecución como serie inmutable de eventos que permite reconstruir *todo*.
2. **Consola de ejecución + Replay** — visualización en tiempo real (WebSocket) y *time-travel* determinista sincronizado con el editor.
3. **Sistema de Memoria** — temporal, persistente, compartida y semántica, tras una única interfaz `MemoryStore`.

Principios rectores (SOLID / Clean Architecture):

- **DIP**: el Motor de Ejecución **solo** depende de dos puertos: `TelemetryPort` y `MemoryStore`. No conoce WebSocket, Postgres, Redis, pgvector ni el frontend.
- **OCP**: nuevos backends de memoria, nuevos modelos de IA (precios) y nuevos transportes de telemetría se añaden como **plugins/adaptadores** que implementan un SPI, sin modificar el núcleo.
- **Fuente única de verdad**: el **log de eventos** (`execution_events`) es append-only y ordenado. Todo lo demás (estado en vivo, consola, coste, replay, incluso el estado de memoria durante el replay) es una **proyección derivable** del log.
- **Determinismo del replay**: los efectos no deterministas (respuesta del LLM, salida de una tool, ids/timestamps generados) se **graban** como eventos y se **reproducen desde el log**, nunca se re-ejecutan.

---

## 1. Modelo de telemetría (event-sourcing)

### 1.1 El evento como unidad

Una `Execution` es una secuencia de `ExecutionEvent` con un `seq` **monotónico por ejecución**. El estado visible nunca se persiste como verdad primaria; se **reduce** desde los eventos.

```ts
// packages/telemetry-core/events.ts  (paquete COMPARTIDO backend/frontend)

export type EventType =
  | 'execution.started'   | 'execution.finished'
  | 'node.entered'        | 'node.exited'
  | 'status.changed'      // blocked|in_progress|wait_for_review|done|error
  | 'llm.requested'       | 'llm.completed'   | 'llm.token'   // streaming
  | 'tool.called'         | 'tool.returned'   | 'tool.failed'
  | 'memory.read'         | 'memory.written'  | 'memory.searched'
  | 'variables.updated'
  | 'log'                 | 'error'
  | 'branch.taken'        | 'wait.started'    | 'wait.resolved'
  | 'retry.attempted'     | 'human.requested' | 'human.resolved';

export interface ExecutionEventBase {
  id: string;                 // uuid, idempotencia en append
  executionId: string;
  seq: number;                // monotónico por executionId
  ts: string;                 // ISO; timestamp GRABADO (usado en replay, no recalculado)
  nodeId?: string;
  agentId?: string;
  parentSpanId?: string;      // spans anidados (nodo -> tool -> llm)
  type: EventType;
}

// Tipo discriminado por `type` — un payload concreto por evento:
export type ExecutionEvent =
  | (ExecutionEventBase & { type: 'llm.completed'; payload: LlmCompletedPayload })
  | (ExecutionEventBase & { type: 'tool.called';   payload: ToolCalledPayload })
  | (ExecutionEventBase & { type: 'memory.written';payload: MemoryWritePayload })
  /* ...resto... */;

export interface LlmCompletedPayload {
  model: string;
  promptRef: BlobRef | string;      // prompt (externalizado si es grande)
  responseRef: BlobRef | string;    // respuesta del modelo
  usage: TokenUsage;                // { promptTokens, completionTokens, cachedTokens }
  finishReason: string;
  latencyMs: number;
}

export interface ToolCalledPayload {
  tool: string;                     // 'git', 'http', 'playwright'...
  input: unknown;                   // redactado/externalizado
  callId: string;                   // correla con tool.returned/failed
}
```

Cada `step` de la consola/observabilidad captura, vía estos eventos: **estado, tiempo, nodo actual, logs, errores, llamadas a herramientas (input/output), prompts usados, respuesta del modelo, tokens, coste, uso de memoria, variables/contexto.**

### 1.2 Puerto de emisión (lo único que ve el motor)

```ts
export interface TelemetryPort {
  emit(event: ExecutionEvent): void;         // no bloqueante (fire-and-forget)
  span(meta): SpanHandle;                     // azúcar para abrir/cerrar spans anidados
  flush(executionId: string): Promise<void>;  // garantiza persistencia (fin de nodo/ejecución)
}
```

El motor hace `telemetry.emit({...})`. No sabe si detrás hay una cola, Postgres o WS.

### 1.3 Almacén de eventos (append-only)

```ts
export interface ExecutionEventStore {
  append(events: ExecutionEvent[]): Promise<void>;   // batch, idempotente por id
  read(executionId: string, opts?: {
    fromSeq?: number; toSeq?: number; types?: EventType[];
  }): AsyncIterable<ExecutionEvent>;
  lastSeq(executionId: string): Promise<number>;
}
```

**Tabla `execution_events`** (append-only):

| campo | tipo | notas |
|---|---|---|
| id | uuid PK | idempotencia |
| execution_id | uuid | FK Execution |
| seq | bigint | **UNIQUE(execution_id, seq)**, monotónico |
| type | text | discriminador |
| node_id / agent_id | uuid null | contexto |
| parent_span_id | uuid null | anidamiento |
| ts | timestamptz | grabado |
| payload_jsonb | jsonb | payload redactado |
| payload_blob_ref | text null | referencia si el payload es grande |

Índices: `(execution_id, seq)`, `(execution_id, type)`. **Particionado por rango de tiempo** para volumen. Escritura vía **cola BullMQ** con *buffer* para amortiguar picos (token streaming).

El `seq` se asigna serializado por `executionId` (contador `INCR` en Redis o `nextval` dedicado) para evitar reordenamientos bajo concurrencia; el `append` es idempotente por `id`.

---

## 2. Proyección de estado y consola en vivo

### 2.1 Reducer determinista COMPARTIDO

La clave para que **consola en vivo** y **replay** coincidan es un único reducer puro, publicado en un paquete TS importado por backend y frontend:

```ts
// packages/telemetry-core/reducer.ts
export interface ExecutionState {
  status: ExecStatus;
  currentNodeId?: string;
  nodes: Record<NodeId, NodeRuntimeState>;   // estado, entradas/salidas, error
  variables: Record<string, unknown>;        // contexto {ticket, repository, memory, variables}
  logs: LogLine[];
  cost: CostAccumulator;                      // tokens y coste acumulado
  memoryView: MemorySnapshot;                 // reconstruida desde eventos memory.*
  cursorSeq: number;
}

// PURA: sin Date.now(), sin random, sin I/O
export function reduce(prev: ExecutionState, ev: ExecutionEvent): ExecutionState;
export function initialState(exec: ExecutionMeta): ExecutionState;
```

El backend usa `reduce` para mantener la proyección viva; el frontend usa **el mismo `reduce`** para el time-travel. Se blindan con tests *property-based*: reducir el log completo debe dar el mismo `ExecutionState` en ambos lados.

### 2.2 Gateway WebSocket

```ts
// namespace /executions/:id
// cliente -> { op: 'subscribe', executionId, fromSeq? }
// servidor -> { seq, event, ts }
```

`TelemetryGateway` (NestJS WS):
- Fan-out multi-instancia vía **Redis Pub/Sub** (una instancia recibe eventos, todas las suscritas los reenvían a sus clientes).
- **Resync por `seq`**: si el cliente detecta un hueco, pide `fromSeq` y el gateway rellena desde `ExecutionEventStore`.
- **Coalescing** de `llm.token` (streaming) para no saturar la red.
- Backpressure por cliente lento.

La consola muestra en tiempo real: workflow, estado, tiempo, nodo actual, historial, tokens, coste estimado, logs, errores, llamadas a herramientas, prompts, respuesta del modelo, uso de memoria y variables — todo derivado del `ExecutionState`.

---

## 3. Replay / time-travel determinista

### 3.1 Snapshots

Reproducir desde `seq=0` en workflows largos es caro. `SnapshotManager` materializa `ExecutionState` cada N eventos o por salida de nodo:

```ts
export interface SnapshotManager {
  maybeSnapshot(executionId: string, state: ExecutionState, seq: number): Promise<void>;
  nearestSnapshot(executionId: string, seq: number): Promise<{ seq: number; state: ExecutionState } | null>;
}
```
Tabla `execution_snapshots(execution_id, seq, state_jsonb)` con `UNIQUE(execution_id, seq)`.

### 3.2 Servicio de replay

```ts
export interface ReplayService {
  stateAt(executionId: string, seq: number): Promise<ExecutionState>; // snapshot + reduce hasta seq
  timeline(executionId: string): Promise<StepIndex[]>;                 // scrubber (por nodo/step)
  openSession(executionId: string): Promise<ReplayCursor>;            // step forward/back
}
```

`stateAt` = tomar `nearestSnapshot(seq)` y aplicar `reduce` sobre los eventos `(snapshotSeq, seq]`. **Determinista** porque solo lee del log.

### 3.3 Determinismo estricto

- Todo efecto no determinista se **graba**: respuesta LLM (`llm.completed`), salida de tool (`tool.returned`), ids/timestamps.
- En modo replay se inyecta un `ReplayExecutionContext` que sirve resultados **desde el log** y **prohíbe I/O real**. El motor no vuelve a llamar al LLM ni a la tool.
- Se ofrece opcionalmente un modo **`re-run`** (debugging) que sí re-ejecuta; queda marcado como *no determinista* en la UX.

### 3.4 Sincronización con el editor

El replay se reproduce **contra la `WorkflowVersion` inmutable** con la que corrió la ejecución (no contra el grafo editado después). El overlay de React Flow resalta `currentNodeId`, colorea nodos por estado y, en cada `seq`, el panel muestra prompt/respuesta/tools/variables/memoria de ese punto. El scrubber está indexado por `timeline()`.

---

## 4. Contabilidad de tokens y coste

### 4.1 Precios versionados

```ts
export interface ModelPricingRegistry {
  get(modelId: string, at: Date): PricingRow | null;
}
export interface CostCalculator {
  price(modelId: string, usage: TokenUsage, at: Date): Money;
}
```

**Tabla `model_pricing`** con vigencia (`valid_from`, `valid_to`, `input_price_per_1k`, `output_price_per_1k`, `cached_input_price_per_1k`, `currency`). El coste histórico no se rompe al cambiar precios porque se resuelve por la **fecha del evento**. Nuevos modelos de IA se añaden por configuración/plugin (`CostProvider` SPI).

### 4.2 Agregación incremental

`TokenAccountingProjector` consume `llm.completed` (y tools de pago) y actualiza `execution_cost_rollup` agrupado por `execution | agent | node | model`, evitando recorrer el log en cada consulta.

`GET /executions/:id/cost?groupBy=agent|node|model` sirve el rollup para el panel de la consola y para límites/facturación.

---

## 5. Sistema de Memoria

### 5.1 Puerto único `MemoryStore`

```ts
export type MemoryScopeKind = 'execution' | 'agent' | 'workflow' | 'shared';

export interface MemoryScope {
  kind: MemoryScopeKind;
  orgId: string; workspaceId: string;
  ref: string;              // executionId | agentId | workflowId | sharedKey
  namespace?: string;
  ttlSeconds?: number;      // solo temporal
  retention?: RetentionPolicy;
}

export interface MemoryStore {
  get(scope: MemoryScope, key: string): Promise<MemoryValue | null>;
  set(scope: MemoryScope, key: string, value: MemoryValue, opts?: SetOpts): Promise<void>;
  append(scope: MemoryScope, key: string, item: MemoryValue): Promise<void>;
  delete(scope: MemoryScope, key: string): Promise<void>;
  list(scope: MemoryScope, prefix?: string): Promise<MemoryEntry[]>;
  // memoria semántica / vector:
  search(scope: MemoryScope, query: string, k: number): Promise<SemanticHit[]>;
}
```

El motor y los agentes dependen **solo** de `MemoryStore`. El contexto `{ticket, repository, memory, variables}` que fluye entre nodos lee/escribe a través de este puerto.

### 5.2 Resolución de backend (Strategy)

```ts
export interface MemoryScopeResolver { resolve(scope: MemoryScope): MemoryBackend; }
```

| scope.kind | backend | almacenamiento | uso |
|---|---|---|---|
| `execution` (temporal) | `RedisMemoryBackend` | Redis + TTL | vive el scope de la ejecución |
| `agent` / `workflow` (persistente) | `PgMemoryBackend` | `memory_entries` | recuerdo estable por agente/workflow |
| `shared` (compartida) | `PgMemoryBackend` + locks | `memory_entries` | intercambio entre agentes/pasos |
| semántica | `VectorMemoryBackend` | `memory_embeddings` (pgvector) | `search()` por similitud |

**Tabla `memory_entries`**: `UNIQUE(org_id, scope_kind, scope_ref, namespace, key)`, con `ttl_at`, `retention_policy`, namespacing por `org/workspace` (aislamiento multi-tenant).
**Tabla `memory_embeddings`**: `embedding vector`, `model_id`, `chunk_text`, índice `hnsw`/`ivfflat`. `VectorMemoryBackend.search()` hace ANN filtrado por `org_id`/`scope_ref`.

Añadir un backend nuevo (otro vector DB) = implementar `MemoryBackend` y registrarlo en el resolver (**OCP**, sin tocar el núcleo).

### 5.3 Memoria en el replay (puente de eventos)

Para que el replay reconstruya también el estado de memoria de forma determinista:

```ts
// Decorador sobre MemoryStore usado durante ejecuciones
class MemoryEventBridge implements MemoryStore {
  // on set/append/delete -> emite ExecutionEvent memory.written/read + delega al backend real
  // en modo REPLAY -> sirve valores desde el log, NO toca el backend real
}
```

Así, cada mutación de memoria queda como evento (`memory.written` / `memory.read` / `memory.searched`) y el `reduce` reconstruye `memoryView` en cualquier `seq`, sin re-embeder ni re-ejecutar tools.

### 5.4 Retención

`RetentionPolicyEngine` (jobs BullMQ / cron), configurable por Organization/Workspace:
- TTL de memoria temporal (Redis).
- Purga/anonimización de logs, prompts y respuestas según política.
- Compactación de eventos antiguos a **cold storage**; truncado de payloads grandes con `BlobRef`.
- Limpieza de embeddings huérfanos / re-embedding al cambiar de modelo.

---

## 6. Seguridad y payloads

- `PayloadRedactor` obligatorio **antes de persistir** cualquier evento: redacta secretos/PII de prompts, respuestas y payloads de tools. Nunca se loggean valores desreferenciados del Secret Manager (solo la referencia).
- `BlobRefStore` externaliza payloads grandes (respuesta del modelo, output de tool) a object storage; el evento guarda solo la referencia.
- RBAC sobre `/executions/:id/events`, `/state`, `/memory`: solo miembros del workspace con permiso pueden ver prompts/respuestas.
- Cifrado at-rest de payloads sensibles y de la memoria persistente.

---

## 7. Contratos REST/WS (resumen)

```
WS   /executions/:id           subscribe{fromSeq} -> frames {seq,event,ts}, resync por gap
GET  /executions/:id/events    ?fromSeq&toSeq&types           (log paginado/stream)
GET  /executions/:id/state     ?atSeq | ?atTime               (estado reconstruido)
GET  /executions/:id/timeline                                  (índice de steps)
GET  /executions/:id/cost      ?groupBy=agent|node|model       (rollup)
POST /executions/:id/replay/session                            (abre cursor)
GET/POST/DELETE /memory        (scope,key)                     (memoria KV)
POST /memory/search            {scope,query,k}                 (semántica)
```

SPIs de plugin: `TelemetryPort` (transporte/almacén de telemetría), `MemoryStore`/`MemoryBackend` (backends de memoria), `CostProvider`/`ModelPricingRegistry` (precios de nuevos modelos).

---

## 8. Cómo alimenta el roadmap

El orden fundacional→avanzado (ver `suggestedMilestones`): **M1** log de eventos + `TelemetryPort` (base de todo) → **M2** consola en vivo + reducer compartido → **M3** coste (paralelizable con M2) → **M4** replay + snapshots (reutiliza el reducer) → **M5** MemoryStore temporal/persistente → **M6** memoria compartida + replay de memoria (une observabilidad y memoria) → **M7** memoria semántica/vector + retención avanzada (todo por plugin, sin tocar el núcleo). Las dependencias duras: M2/M3/M4 requieren M1; M4 reutiliza el reducer de M2; M6 requiere M5 y M4; M7 requiere M5/M6.
