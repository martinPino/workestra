Voy a producir el documento directamente. No requiere exploración de código ni herramientas externas; es un deep-dive de diseño autocontenido en español.

# Deep-Dive Final — Editor Visual de Workflows

> **Área PRIORITARIA 1.** Objetivo: un editor de workflows extremadamente fluido, extensible por plugins y con overlay de ejecución en vivo + replay, donde **añadir un nuevo tipo de nodo no requiere tocar el editor ni el motor**. Este documento es la especificación de referencia para construir el editor, y absorbe las correcciones de secuenciación y de-riesgado señaladas en la crítica (contrato de eventos append-only desde el inicio, presupuesto de rendimiento validado temprano, registro incremental de nodos, publicación/versionado de workflows como preocupación de primera clase).

---

## 0. Principios rectores (y cómo responden a la crítica)

1. **Extensibilidad Open/Closed real.** El motor de renderizado, la paleta, el panel de propiedades y la validación son genéricos. Un tipo de nodo nuevo se declara con `register(def)` y nada más. **Corrección de crítica (M2):** el `NodeTypeRegistry` soporta **registro incremental**; no se fuerza declarar "los 11 tipos" de golpe: cada tipo entra cuando su runtime existe o es trivial.
2. **El contrato de evento de ejecución es artefacto de primera clase desde el día 1.** El `ExecutionEvent` append-only y el `ExecutionStateReducer` puro (compartido cliente/servidor) se **congelan con versionado desde el inicio**, no en M6. Live y replay consumen el mismo reducer. **Corrección de crítica (M6):** el editor solo aporta proyecciones/UI; nunca rediseña el contrato tarde.
3. **Separación estricta layout ↔ DAG ejecutable.** El motor recibe solo `nodes/edges/config`. Posiciones, grupos y comentarios viajan en `layoutMeta` (jsonb), fuera del grafo ejecutable (ISP).
4. **Command pattern como única vía de escritura.** Undo/redo determinista + patches para autosave + telemetría, todo derivado del mismo objeto `Command`.
5. **Rendimiento validado temprano, no al final.** **Corrección de crítica (M2/de-riesgado P1):** presupuesto de rendimiento y prueba con grafo sintético de 500+ nodos entran como criterio de aceptación temprano; el `CycleIndex` incremental y el store normalizado se prueban a escala antes de invertir en features.
6. **Publicación/versionado de workflows es parte del editor.** **Corrección de crítica (completeness):** estados `draft/published/archived`, pin de versión por ejecución y "editar no altera ejecuciones en vuelo" son parte del diseño, no un añadido tardío.

---

## 1. Arquitectura front en tres capas (SOLID / Clean)

```
┌──────────────────────────────────────────────────────────────────────┐
│ PRESENTACIÓN (React puro, sin lógica de dominio)                       │
│  CanvasView · NodeRenderers · Toolbar · Palette · Minimap · GroupChrome│
│  NodePropertiesPanel (schema-driven) · ExecutionOverlay · ReplayScrubber│
│  CommentLayer · IssuesPanel · VersionBar (draft/published)             │
├──────────────────────────────────────────────────────────────────────┤
│ ESTADO / DOMINIO (Zustand + Command pattern) — sin React ni red        │
│  GraphStore (nodes/edges/groups/comments/viewport)                     │
│  SelectionSlice · HistorySlice · ExecutionSlice · ClipboardService     │
│  CommandBus · EdgeValidator · CycleIndex · NodeTypeRegistry            │
│  ExecutionStateReducer (PURO, compartido con backend)                  │
├──────────────────────────────────────────────────────────────────────┤
│ SYNC (React Query + WS, aislamiento total de red)                      │
│  EditorSyncService · WorkflowGateway · EditorModelMapper               │
│  ExecutionStream (WS) · AutoLayoutWorker (Web Worker) · VersionGateway  │
└──────────────────────────────────────────────────────────────────────┘
```

**Regla de dependencia:** `presentación → estado → sync`. La presentación **nunca** llama a la API ni muta el store: despacha comandos y lee selectores. El sync no conoce React Flow; solo el `EditorModelMapper` conoce ambos modelos. El `ExecutionStateReducer` no conoce React ni la red: es una función pura reutilizada por el servidor.

### Responsabilidades por librería

| Librería | Rol | Frontera |
|---|---|---|
| **React Flow** | Render del canvas: nodos, aristas, handles, zoom/pan, minimapa, box-select, drag. Fuente de eventos de interacción. | No es fuente de verdad. Se hidrata desde el store; sus `onChange` se traducen a comandos. |
| **Zustand** | Fuente de verdad del editor. Estado normalizado + slices. | Escritura solo vía `CommandBus._apply`. `setState` directo prohibido por lint. |
| **React Query** | Toda la red: carga de versión, autosave con patches, logs de replay, catálogos (agents/tools/connectors). Caché, reintentos, invalidación. | No toca el store directamente; entrega DTOs al `EditorModelMapper`. |
| **Web Worker** | Auto-layout (elk/dagre) y, opcionalmente, validación full-graph pesada. | Comunicación por mensajes; resultado se aplica como `LayoutCommand`. |

---

## 2. Modelo de datos del editor

```ts
type NodeKind =
  | 'trigger' | 'agent' | 'condition' | 'loop' | 'wait'
  | 'tool' | 'api' | 'llm' | 'memory' | 'human' | 'end';

type PortDataType = 'context' | 'branch' | 'signal' | 'loop';

interface PortSpec {
  id: string;                    // 'in','out','true','false','body','done','error'
  side: 'in' | 'out';
  dataType: PortDataType;
  accepts?: PortDataType[];      // compatibilidad en el target (solo puertos 'in')
  multiplicity: 'single' | 'many';
  label?: string;
}

interface EditorNode {
  id: NodeId;
  type: NodeKind;
  position: XYPosition;          // vive en layoutMeta al serializar
  data: {
    label: string;
    config: Record<string, unknown>;   // validado contra configSchema (AJV)
    ports: PortSpec[];                  // derivados del NodeTypeDefinition
    valid: boolean;
    issues: ValidationIssue[];
  };
  groupId?: GroupId;
}

interface EditorEdge {
  id: EdgeId;
  source: NodeId; sourceHandle: string;
  target: NodeId; targetHandle: string;
  dataType: PortDataType;
  valid: boolean;
}

interface NodeGroup { id: GroupId; label: string; nodeIds: NodeId[]; color?: string; collapsed?: boolean; }
interface Comment  { id: CommentId; text: string; position: XYPosition; size: Size; color?: string; }

interface GraphState {
  nodes: Record<NodeId, EditorNode>;
  edges: Record<EdgeId, EditorEdge>;
  groups: Record<GroupId, NodeGroup>;
  comments: Record<CommentId, Comment>;
  viewport: Viewport;            // zoom/pan
}

// LAYOUT NO EJECUTABLE, separado del DAG que consume el engine
interface LayoutMeta {
  positions: Record<NodeId, XYPosition>;
  groups: Record<GroupId, NodeGroup>;
  comments: Record<CommentId, Comment>;
  viewport: Viewport;
}
```

**Por qué normalizado (records, no arrays):** selectores atómicos O(1) por id → un nodo se re-renderiza solo si cambia su slice. Es la base del rendimiento con grafos grandes (§9).

---

## 3. NodeTypeRegistry — extensibilidad por plugin (OCP)

Es el corazón de la extensibilidad. Cada tipo se declara una vez y el editor lo consume genéricamente.

```ts
interface NodeTypeDefinition {
  type: NodeKind;
  label: string;
  category: 'trigger' | 'agent' | 'flow' | 'io' | 'terminal';
  icon: React.FC;
  ports: PortSpec[] | ((cfg: NodeData['config']) => PortSpec[]); // dinámicos
  configSchema: JSONSchema7;      // fuente del panel de propiedades
  uiSchema?: UiSchema;            // widgets/orden/labels
  edgeRules: EdgeRuleSet;         // qué puede conectar
  renderer: React.FC<NodeRendererProps>;
  defaults(): NodeData;
  validate?(node: EditorNode, g: GraphSnapshot): ValidationIssue[];
  // Metadata de disponibilidad: soporta registro incremental (corrección crítica M2)
  runtimeStatus: 'available' | 'experimental';
  schemaVersion: number;          // migración de configs cuando el runtime evoluciona
}

interface NodeTypeRegistry {
  register(def: NodeTypeDefinition): void;
  get(type: NodeKind): NodeTypeDefinition;
  all(): NodeTypeDefinition[];
  migrateConfig(type: NodeKind, config: unknown, fromVersion: number): unknown;
}
```

**Registro incremental (respuesta a la crítica M2).** No se declaran "los 11" de golpe. Cada definición lleva `runtimeStatus` y `schemaVersion`. Los tipos cuyo runtime aún no existe se registran como `experimental` (visibles pero marcados en paleta) o simplemente se registran en la fase que trae su runtime. `migrateConfig` reescribe configs guardadas cuando el `configSchema` de un tipo cambia al madurar su runtime, evitando migraciones manuales masivas.

Añadir un nodo nuevo = un `register(...)`. El `nodeTypes` de React Flow y la paleta se **generan** desde `registry.all()`.

---

## 4. Catálogo de los ~11 tipos de nodo

Cada tipo se describe con: **handles** (puertos), **config schema** (resumen de propiedades clave del panel) y **notas de validación**. La columna "Fase" indica cuándo entra al registro según su runtime (respuesta a la crítica M2: no todos en M2).

### 4.1 Tabla resumen de handles

| Tipo | Handles `in` | Handles `out` | Cardinalidad | Notas |
|---|---|---|---|---|
| **Trigger** | — (ninguno) | `out:context` (single) | `inMax:0, outMax:1` | Punto de entrada. Único nodo sin `in`. Solo uno por rama de arranque. |
| **Agent** | `in:context` | `out:context`, `error:signal` | `inMax:1, outMax:2` | Delega en un agente del registro. |
| **Condition** | `in:context` | `true:branch`, `false:branch` (o N ramas dinámicas) | `inMax:1, outMax:2..N` | Puertos dinámicos según modo. |
| **Loop** | `in:context` | `body:loop`, `done:context` | `inMax:1` | `body` reentra; el sub-DAG del body vuelve a un handle de retorno implícito. |
| **Wait** | `in:context` | `out:context` | `inMax:1, outMax:1` | Espera por tiempo/evento/señal externa. |
| **Tool** | `in:context` | `out:context`, `error:signal` | `inMax:1, outMax:2` | Invoca una herramienta-plugin autorizada. |
| **API** | `in:context` | `out:context`, `error:signal` | `inMax:1, outMax:2` | Caso especializado de HTTP genérico. |
| **LLM** | `in:context` | `out:context`, `error:signal` | `inMax:1, outMax:2` | Llamada directa a modelo sin agente completo. |
| **Memory** | `in:context` | `out:context` | `inMax:1, outMax:1` | Lee/escribe memoria (temporal/persistente/compartida). |
| **Human** | `in:context` | `out:context`, `reject:branch` | `inMax:1, outMax:2` | Pausa manual / aprobación. |
| **End** | `in:context` | — (ninguno) | `inMax:many, outMax:0` | Terminal. Puede haber varios End. |

### 4.2 Config schemas (resumen por tipo)

**Trigger** (`Fase: temprana`)
```ts
{ type:'object', required:['event'], properties:{
  event: { enum:['issue.created','issue.updated','pr.opened','pr.merged','commit','webhook','cron','manual','api'] },
  cron: { type:'string', title:'Expresión cron' },          // uiSchema: visible si event==='cron'
  connectorId: { type:'string', 'ui:widget':'connector-select' },
  filter: { type:'string', title:'Filtro (JSONLogic sobre el payload)' },
}}
```

**Agent** (`Fase: cuando existe AgentRuntime`)
```ts
{ type:'object', required:['agentId'], properties:{
  agentId: { type:'string', 'ui:widget':'agent-select' },   // context.agents
  inputMapping: { type:'object', 'ui:widget':'variable-map' },
  timeoutMs: { type:'integer', default:120000 },
  retries: { type:'integer', default:1, maximum:5 },
  onError: { enum:['fail','continue','route-error'], default:'route-error' },
}}
```

**Condition** (`Fase: temprana`) — puertos dinámicos
```ts
{ type:'object', required:['expression'], properties:{
  mode: { enum:['jsonlogic','jmespath'], default:'jsonlogic' },
  expression: { type:'string', title:'Expresión (contexto)' },
  branches: { type:'array', title:'Ramas extra',            // >2 salidas
    items:{ type:'object', properties:{ label:{type:'string'}, when:{type:'string'} } } },
}}
// ports(cfg) genera true/false, o una salida por cada branch + default
```

**Loop** (`Fase: cuando existe runtime de bucle`)
```ts
{ type:'object', required:['kind'], properties:{
  kind: { enum:['forEach','while','times'] },
  collection: { type:'string', title:'Colección (forEach)' },
  condition: { type:'string', title:'Condición (while)' },
  count: { type:'integer', title:'Iteraciones (times)' },
  maxIterations: { type:'integer', default:1000 },          // guarda anti-loop infinito
  parallelism: { type:'integer', default:1 },               // 1 = secuencial
}}
```

**Wait** (`Fase: cuando existe timer/resume`)
```ts
{ type:'object', properties:{
  kind: { enum:['duration','until','event','signal'], default:'duration' },
  durationMs: { type:'integer' },
  untilExpression: { type:'string' },
  eventName: { type:'string' },
}}
```

**Tool** (`Fase: cuando existe ToolInvoker`)
```ts
{ type:'object', required:['toolId'], properties:{
  toolId: { type:'string', 'ui:widget':'tool-select' },     // solo tools autorizadas del agente/ctx
  operation: { type:'string', 'ui:widget':'tool-operation-select' },
  params: { type:'object', 'ui:widget':'variable-map' },
  mockable: { type:'boolean', default:true },               // habilita dry-run (ver §11)
}}
```

**API** (`Fase: temprana` — HTTP genérico)
```ts
{ type:'object', required:['method','url'], properties:{
  method: { enum:['GET','POST','PUT','PATCH','DELETE'] },
  url: { type:'string' },
  headers: { type:'object' },
  body: { type:'string', 'ui:widget':'code' },
  auth: { type:'string', 'ui:widget':'secret-ref' },        // referencia a Secret, nunca el valor
  timeoutMs: { type:'integer', default:30000 },
}}
```

**LLM** (`Fase: cuando existe LLMProvider`)
```ts
{ type:'object', required:['model','prompt'], properties:{
  model: { type:'string', 'ui:widget':'model-select' },
  prompt: { type:'string', 'ui:widget':'prompt-editor' },
  temperature: { type:'number', default:0.7, minimum:0, maximum:2 },
  maxTokens: { type:'integer' },
  responseFormat: { enum:['text','json'], default:'text' },
  jsonSchema: { type:'object', title:'Schema (si responseFormat=json)' },
}}
```

**Memory** (`Fase: cuando existe MemoryStore`)
```ts
{ type:'object', required:['op','scope'], properties:{
  op: { enum:['read','write','append','search','clear'] },
  scope: { enum:['temporal','persistent','shared'] },
  key: { type:'string' },
  query: { type:'string', title:'Consulta semántica (search)' },
  value: { type:'string', 'ui:widget':'variable-map' },
}}
```

**Human** (`Fase: cuando existe escalado humano`)
```ts
{ type:'object', required:['prompt'], properties:{
  prompt: { type:'string', title:'Mensaje al aprobador' },
  assignee: { type:'string', 'ui:widget':'user-select' },
  channel: { enum:['dashboard','slack','email'], default:'dashboard' },
  timeoutMs: { type:'integer' },                             // SLA de aprobación
  onTimeout: { enum:['reject','escalate','continue'], default:'reject' },
}}
```

**End** (`Fase: temprana`)
```ts
{ type:'object', properties:{
  status: { enum:['success','failure','cancelled'], default:'success' },
  output: { type:'object', 'ui:widget':'variable-map' },
}}
```

> **Nota de de-riesgado (crítica M8 / seguridad de tools):** las tools potencialmente peligrosas (Git/Filesystem/Docker) se marcan en su `NodeTypeDefinition`/`uiSchema` como `requiresSandbox`. El editor muestra un badge de "requiere sandbox" y, si el sandbox real no está disponible en el entorno, el nodo se pinta con `issue` bloqueante. Así el editor refleja la restricción de seguridad sin que el usuario descubra tarde que la tool no puede ejecutarse sin aislamiento.

---

## 5. GraphStore (Zustand) + Command pattern

Estado normalizado con slices para selectores atómicos:

```ts
interface EditorStore extends GraphState, SelectionSlice, HistorySlice, ExecutionSlice {
  // ÚNICA vía de escritura interna, invocada por CommandBus:
  _apply(mutator: (draft: GraphState) => void): void;   // usa immer para patches
}
```

Toda mutación es un `Command` con inversa → undo/redo determinista y patches para el backend:

```ts
interface Command {
  id: string;
  label: string;                         // 'Mover nodo', 'Conectar', 'Pegar 3 nodos'
  apply(s: EditorStore): void;
  invert(): Command;
  coalesceWith?(next: Command): Command | null; // fusiona drags contiguos
  toPatch(): GraphPatch;                  // para EditorSyncService (autosave)
}

interface CommandBus {
  dispatch(cmd: Command): void;           // apply + push a history + emit patch
  undo(): void;                           // pop past → apply invert → push future
  redo(): void;
  batch(fn: () => void): void;            // agrupa varios commands en uno (transacción)
}
```

**Comandos concretos:** `AddNodeCommand`, `RemoveNodesCommand`, `MoveNodesCommand` (coalescible), `ConnectEdgeCommand`, `DisconnectEdgeCommand`, `UpdateNodeConfigCommand`, `GroupNodesCommand`, `UngroupCommand`, `AddCommentCommand`, `PasteCommand`, `LayoutCommand`.

**Coalescing:** durante un drag, cada frame produce un `MoveNodesCommand`; `coalesceWith` los fusiona en uno solo → el historial guarda "Mover 3 nodos" como una entrada, no 60. El mismo mecanismo agrupa cambios de config debounced.

**Invariante testeable (property-based):** `cmd.invert().apply()` deshace exactamente `cmd.apply()`; formalmente `apply ∘ invert = identidad` sobre `GraphState`. Se testea con fast-check generando comandos aleatorios.

**Regla dura (lint):** los componentes solo leen (`useStore(selector)`) y despachan comandos. `setState` directo está prohibido — rompería el historial y el autosave. Se aplica con typing (el store no exporta `setState` público) + regla ESLint custom.

---

## 6. Validación de aristas y DAG guard

```ts
interface EdgeValidator {
  canConnect(c: ConnectionCandidate, g: GraphSnapshot): EdgeValidation;
}
type EdgeValidation =
  | { ok: true }
  | { ok: false; reason:
      'cycle' | 'type-mismatch' | 'cardinality' | 'self-loop' | 'duplicate';
      message: string };
```

**Orden de chequeos** (barato → caro, corto-circuito): `self-loop → duplicado → tipado (source.dataType ∈ target.accepts) → cardinalidad (outMax/inMax) → ciclo`.

**Índice incremental de ciclos** para no recomputar la topología en cada intento de arrastre:

```ts
interface CycleIndex {
  wouldCreateCycle(from: NodeId, to: NodeId): boolean; // amortizado bajo
  onAddEdge(e: EditorEdge): void;
  onRemoveEdge(e: EditorEdge): void;
}
```

Implementación: orden topológico incremental (algoritmo estilo PK — Pearce/Kelly) que mantiene un rango por nodo y solo re-ordena la ventana afectada al insertar una arista. Evita un DFS O(V+E) por cada hover durante el drag.

**Integración con React Flow:** `isValidConnection(connection)` delega en `EdgeValidator` para pintar el handle verde/rojo mientras el usuario arrastra. Al guardar/publicar, una **validación full-graph** confirma que el snapshot es un DAG válido (conexo desde triggers, sin nodos huérfanos, todos los `End` alcanzables) antes de mapear al engine.

> **De-riesgado temprano (crítica P1/M2):** el `CycleIndex` incremental debe validarse contra un **grafo sintético de 500+ nodos** como criterio de aceptación de la fase que lo introduce, no en la fase de escala final. Si el índice no escala, se descubre cuando aún es barato corregirlo.

---

## 7. Panel de propiedades schema-driven

El panel se genera desde `configSchema` + `uiSchema`; **ningún tipo de nodo necesita UI a medida** en el editor.

```ts
interface SchemaFormProps {
  schema: JSONSchema7;
  uiSchema?: UiSchema;
  value: unknown;
  context: FormContext;               // agents, tools, connectors, variables, secrets(refs)
  onChange(patch: Record<string, unknown>): void; // → UpdateNodeConfigCommand (debounced ~300ms)
}
```

**Registro de widgets inyectables** (`uiSchema['ui:widget']`) para casos ricos, con fallback a widget genérico por tipo JSON Schema:

| Widget | Uso |
|---|---|
| `agent-select` | Selector de agente desde `context.agents`. |
| `tool-select` / `tool-operation-select` | Solo tools autorizadas; operaciones según la tool. |
| `connector-select` / `model-select` / `user-select` | Selectores de catálogo. |
| `prompt-editor` | Editor de prompt con resaltado de variables `{{ctx.x}}`. |
| `variable-map` | Mapeo visual de variables de contexto → params. |
| `secret-ref` | Referencia a un `Secret` del Secret Manager; **nunca** el valor en claro. |
| `code` | Editor de código (body, JSON) con validación. |

**Validación en vivo con AJV:** los errores del schema se reflejan como `issues` del nodo y marcan el nodo inválido en el canvas (borde rojo + badge de conteo). El `IssuesPanel` global lista todos los `issues` del grafo y permite saltar al nodo. Publicar está bloqueado si hay `issues` bloqueantes.

---

## 8. Overlay de ejecución en vivo + replay (contrato de eventos de primera clase)

**Corrección central de la crítica (M6):** el contrato de evento y el reducer no nacen en M6. El `ExecutionEvent` append-only y el `ExecutionStateReducer` puro se congelan con versionado desde el inicio y se comparten cliente/servidor. El editor solo aporta las proyecciones/UI.

### 8.1 Contrato de evento append-only (compartido, versionado)

```ts
interface ExecutionEvent {
  v: 1;                                  // versión de schema, congelada y migrable
  runId: string;
  seq: number;                           // orden total determinista
  ts: number;                            // timestamp GRABADO (no Date.now() en el reducer)
  type: 'execution.started' | 'node.entered' | 'node.status'
      | 'node.output' | 'tool.called' | 'tool.result'
      | 'llm.call' | 'llm.result' | 'memory.op'
      | 'branch.taken' | 'node.exited' | 'execution.status';
  nodeId?: NodeId;
  payload: Record<string, unknown>;      // incluye TODO efecto no determinista grabado
}
```

**Disciplina de determinismo (respuesta directa a la crítica):** todo efecto no determinista (random seeds, timestamps, outputs completos de tools, orden de tool-calls, tokens, coste) se **graba como evento**. El reducer es puro: `Date.now()`/`Math.random()` están **prohibidos en el reducer** por lint + test. Esto garantiza que replay reconstruye el estado exacto sin re-emitir ni migrar eventos tardíamente.

### 8.2 Reducer puro compartido

```ts
// Misma función en cliente (overlay/replay) y servidor (proyección de estado).
function executionStateReducer(state: ExecutionSlice, ev: ExecutionEvent): ExecutionSlice;

interface ExecutionSlice {
  runId?: string;
  mode: 'live' | 'replay' | 'idle';
  nodeStates: Record<NodeId, NodeExecState>;
  cursor: number;                        // índice en el log para replay
  totals: { tokens: number; costUsd: number; elapsedMs: number };
}
type NodeExecState = {
  status: 'pending'|'running'|'ok'|'error'|'waiting'|'skipped';
  startedAt?: number; endedAt?: number; tokens?: number; costUsd?: number; error?: string;
  branchTaken?: string;
};
```

### 8.3 Live

`ExecutionOverlayController` abre `WS /executions/{id}/stream`, recibe `ExecutionEvent`s, hace **throttling/batching por frame** (coalesce de eventos rápidos en un solo re-render) y aplica el reducer sobre `ExecutionSlice`. Los renderers pintan halo/borde por estado y muestran tokens/coste acumulado. El minimapa colorea nodos por estado para ver el frente de ejecución de un vistazo.

### 8.4 Replay

`GET /executions/{id}/logs` → `ReplayController.load(log)`. `play/pause/step/seek(cursor)` recalculan `nodeStates` **puramente desde el log** con el mismo reducer, sin backend:

```ts
interface ReplayController {
  load(log: ExecutionEvent[]): void;
  play(): void; pause(): void;
  step(dir: 1 | -1): void; seek(cursor: number): void;
  speed(mult: number): void;             // 0.5x..8x
}
```

El **mismo overlay** sirve para live y replay (DRY). El `ReplayScrubber` es una barra temporal con marcas por evento; al hacer `seek`, el reducer se re-ejecuta desde el último snapshot ≤ cursor (snapshots periódicos para O(1) amortizado en logs largos).

> **De-riesgado del Orchestrator (crítica M5/M6):** una **vista básica del árbol de plan/sub-DAG** basada en estos mismos eventos debe estar disponible tan pronto como el Orchestrator emita eventos, aunque el scrubber time-travel completo llegue después. Observar por qué falló un plan multi-agente no puede esperar a la fase de observabilidad completa.

---

## 9. Rendimiento con grafos grandes

- **Estado normalizado + selectores atómicos por nodo** (`useStore(s => s.nodes[id])`) → un nodo re-renderiza solo si cambia su slice.
- **`React.memo`** en renderers con comparador estrecho; handles y labels memoizados.
- **Virtualización/culling de viewport:** no montar nodos fuera de pantalla en grafos grandes; aristas simplificadas (líneas rectas, sin labels) por debajo de cierto zoom (LOD — level of detail).
- **Throttling** de eventos WS y de `onNodesChange` (drag) con coalescing de comandos (§5).
- **AutoLayout (elk/dagre) en Web Worker** para no bloquear el hilo de UI; el resultado se aplica como `LayoutCommand` (undoable).
- **`CycleIndex` incremental** (§6) en vez de DFS por hover.

**Presupuesto de rendimiento (criterio de aceptación temprano — crítica P1/M2):**

| Métrica | Objetivo | Se valida en |
|---|---|---|
| Grafo sintético | 500+ nodos / 800+ aristas | Fase temprana del editor |
| Frame de drag | < 16 ms (60 fps) con culling | Fase temprana |
| `wouldCreateCycle` | < 1 ms amortizado a 500 nodos | Fase temprana |
| Re-render al mover 1 nodo | Solo ese nodo + sus aristas | Fase temprana |
| Apertura de workflow grande | < 1.5 s hasta interactivo | Fase temprana |

Validar la arquitectura de store/render **contra el objetivo antes** de invertir en features evita descubrir en la fase de escala final que hay que reescribir la pieza de Prioridad 1.

---

## 10. Sync con backend, versionado y mapeo bidireccional

```ts
interface WorkflowGateway {
  getVersion(id, version): Promise<WorkflowVersionDTO>;
  applyPatch(id, version, patch: GraphPatch, baseVersion: number): Promise<PatchResult>;
  createVersion(id, snapshot: GraphSnapshot): Promise<WorkflowVersionDTO>;
}
type PatchResult = { ok: true; newVersion: number } | { ok: false; conflict: GraphDiff };
```

- **Autosave optimista:** cada `Command.toPatch()` se acumula (debounce ~500 ms) y se envía con `baseVersion`. En `409 conflict`, el editor rebasa el patch sobre la última versión o avisa al usuario mostrando el `GraphDiff`.
- **EditorModelMapper** (único que conoce ambos modelos):

```ts
interface EditorModelMapper {
  toEngine(g: GraphState): { nodes: EngineNodeDTO[]; edges: EngineEdgeDTO[]; layout: LayoutMeta };
  fromEngine(dto: WorkflowVersionDTO): GraphState;
}
// Invariante (property-based): fromEngine(toEngine(g)) ≡ g   (round-trip sin pérdida)
```

El engine recibe solo `nodes/edges/config`; `positions/groups/comments/viewport` viajan en `layout` (jsonb en `WorkflowVersion`), fuera del DAG ejecutable.

### 10.1 Publicación / versionado de workflows (respuesta a la crítica de completeness)

El editor trata el ciclo de vida de versiones como preocupación de primera clase:

```ts
type VersionStatus = 'draft' | 'published' | 'archived';

interface VersionGateway {
  publish(id, version): Promise<WorkflowVersionDTO>;   // draft → published (activa)
  archive(id, version): Promise<void>;
  listVersions(id): Promise<VersionSummary[]>;
  diff(id, a, b): Promise<GraphDiff>;                  // comparación visual entre versiones
}
```

- **`VersionBar`** en la UI muestra el estado (draft/published/archived), permite publicar, ver historial y **comparar dos versiones** con resaltado visual de nodos añadidos/eliminados/modificados en el canvas.
- **Regla operativa clave:** editar un workflow crea/actualiza un `draft`; **no altera ejecuciones ya encoladas**, que quedan ancladas (pin) a la `WorkflowVersion` con la que arrancaron. Publicar promociona el draft a versión activa para nuevas ejecuciones. Esto se refleja en el editor: al abrir una versión con ejecuciones en vuelo, se avisa y se ofrece "editar como nuevo draft".

### 10.2 Mapeo editor ↔ modelo backend (entidades)

| Concepto editor | Entidad backend | Notas de mapeo |
|---|---|---|
| `EditorNode` | `Node` | `type`, `config` van al DAG ejecutable; `position/groupId` a `layout`. |
| `EditorEdge` | `Edge` | `source/target` + handles → `sourceHandle/targetHandle`. |
| `GraphState` completo | `WorkflowVersion` | Snapshot inmutable; `layoutMeta` en columna jsonb. |
| Workflow (contenedor) | `Workflow` + `WorkflowVersion[]` | El editor edita un draft; publish crea/activa versión. |
| `config` de nodo Agent | referencia a `Agent` | Solo `agentId`; el agente vive en su propio registro. |
| `config` de nodo Tool | referencia a `Tool`/`Plugin` | Solo `toolId` + operación autorizada. |
| `secret-ref` en config | referencia a `Secret` | Nunca el valor; el engine resuelve en runtime vía Secret Manager. |
| `ExecutionSlice` | `Execution` + `ExecutionLog` | El log es la fuente de verdad append-only; el editor solo proyecta. |
| `Comment` / `NodeGroup` | `layoutMeta` (jsonb) | No ejecutables; nunca llegan al engine. |

---

## 11. Features del canvas — resumen de responsabilidades

| Feature | Mecanismo |
|---|---|
| Zoom / pan / minimapa | React Flow nativo + `layoutMeta.viewport`; minimapa colorea por estado de ejecución. |
| Drag&drop desde paleta | `onDrop` → `AddNodeCommand` con `defaults()` del tipo. |
| Selección múltiple | `SelectionSlice` (box-select, shift-click, `Ctrl+A`). |
| Agrupar / desagrupar | `GroupNodesCommand` / `UngroupCommand` → `NodeGroup` en layoutMeta; grupos colapsables. |
| Copy / paste / cut | `ClipboardService` (reasigna ids, preserva aristas internas al grupo pegado, offset visual). |
| Undo / redo | `HistorySlice` + `CommandBus` (con coalescing). |
| Auto-layout | `AutoLayoutService` (Web Worker, elk/dagre) → `LayoutCommand` undoable. |
| Comentarios | `Comment` en layoutMeta; nodo no ejecutable, redimensionable. |
| Comparar versiones | `VersionGateway.diff` → resaltado en canvas. |
| Dry-run / test | Ejecución en modo simulación con `ToolInvoker` mock (ver abajo). |

**Dry-run / test de workflow (respuesta a la crítica de completeness — TESTING):** el editor ofrece un botón "Probar" que ejecuta el workflow en **modo simulación**: reutiliza el motor con un `ToolInvoker` en modo mock (tools con `mockable:true` devuelven fixtures definidas por el usuario), datos de entrada de ejemplo y asserts opcionales sobre el resultado. Emite los mismos `ExecutionEvent`s, así que el overlay y el replay funcionan idénticos sobre una ejecución de prueba, sin efectos externos reales.

---

## 12. Mini-plan de fases específico del editor

Cada fase es entregable e independientemente demostrable. Las correcciones de la crítica están incorporadas: contrato de eventos y presupuesto de rendimiento entran temprano; registro de nodos es incremental; publicación de versiones no es un añadido tardío; overlay/replay se separan en "contrato temprano" vs "UI de scrubber después".

| Fase | Alcance | Criterios de aceptación (DoD) |
|---|---|---|
| **E0 — Cimientos** | CanvasView con React Flow hidratado desde `GraphStore` normalizado. `NodeTypeRegistry` (registro incremental) con tipos triviales: **Trigger, Condition, API, End**. Paleta y `nodeTypes` generados desde el registro. **Congelar `ExecutionEvent` v1 + `ExecutionStateReducer` puro** (aunque aún no haya ejecuciones reales). `EditorModelMapper` con round-trip test. | Añadir un tipo = un `register()`. `fromEngine(toEngine(g)) ≡ g`. Reducer sin `Date.now()`/`random` (test+lint). |
| **E1 — Command pattern** | `CommandBus`, `HistorySlice`, comandos base (Add/Remove/Move/Connect/Disconnect/UpdateConfig). Coalescing de drags. Autosave optimista con patches + `baseVersion`. | `apply ∘ invert = identidad` (property-based). Undo/redo determinista. `setState` prohibido por lint. |
| **E2 — Rendimiento a escala (temprano)** | Selectores atómicos, `React.memo`, virtualización/culling, `CycleIndex` incremental. **Prueba con grafo sintético 500+ nodos** como gate. | Todos los objetivos del presupuesto (§9) cumplidos con 500+ nodos. |
| **E3 — Validación + panel schema-driven** | `EdgeValidator` (orden de chequeos + DAG guard), `isValidConnection` con handle verde/rojo. Panel schema-driven (AJV) + registro de widgets. `IssuesPanel`. Validación full-graph al publicar. | Conexiones inválidas se bloquean con motivo. Nodos inválidos marcados. Panel funciona para cualquier tipo sin UI a medida. |
| **E4 — Registro incremental de nodos restantes** | Añadir **Agent, Tool, LLM, Memory, Loop, Wait, Human** a medida que sus runtimes existen (o como `experimental` con badge). Widgets ricos (`agent-select`, `prompt-editor`, `variable-map`, `secret-ref`). Badge `requiresSandbox`. | Cada tipo entra sin tocar el motor de render/panel. Tools peligrosas marcadas. |
| **E5 — Overlay live + árbol de plan** | `ExecutionOverlayController` (WS) aplicando el reducer congelado en E0. Halo por estado, tokens/coste. **Vista básica del árbol de plan/sub-DAG del Orchestrator** (co-requisito de de-riesgar P2). | Overlay pinta estados en vivo con throttling por frame. Se puede observar un plan multi-agente ejecutándose. |
| **E6 — Replay + scrubber** | `ReplayController` puro desde el log, `ReplayScrubber`, snapshots periódicos, velocidades. Mismo overlay que live (DRY). | `seek/step/play` reconstruyen estado exacto desde el log sin backend. |
| **E7 — Productividad** | Copy/paste/cut (`ClipboardService`), grupos colapsables, comentarios, auto-layout en Web Worker (`LayoutCommand`), minimapa coloreado por estado. | Todas las features undoables. Auto-layout no bloquea la UI. |
| **E8 — Versionado + dry-run** | `VersionBar` (draft/published/archived), publish, diff visual entre versiones, pin de versión por ejecución. **Dry-run** con `ToolInvoker` mock + fixtures + asserts. | Editar no altera ejecuciones en vuelo. Probar un workflow no produce efectos externos. |

**Dependencias entre fases:** E0 → E1 → {E2, E3} → E4. E5 depende de E0 (contrato de eventos) + que el engine emita eventos; se paraleliza tras E0/E1. E6 depende de E5. E7 depende de E1 (undo). E8 depende de E3 (validación full-graph) + el gateway de versiones. La ruta crítica del editor es E0→E1→E3→E4; E2 (rendimiento) y E5/E6 (observabilidad) se de-riesgan en paralelo, no al final.

---

## 13. Cómo este diseño responde punto por punto a la crítica

| Crítica | Respuesta en este diseño |
|---|---|
| Contrato de eventos/reducer aterriza tarde (M6) y se reescribe | Congelado en **E0** con versionado; determinismo forzado por lint/test; reducer compartido cliente/servidor (§8, §12). |
| Rendimiento a escala se valida al final (M9/M10) | **E2** con gate de 500+ nodos como criterio de aceptación temprano (§9, §12). |
| "Los 11 tipos" de golpe en M2 → especulación de schemas | `NodeTypeRegistry` con **registro incremental**, `runtimeStatus`, `schemaVersion`, `migrateConfig`; tipos entran con su runtime en **E4** (§3, §4, §12). |
| Publicación/versionado de workflows ausente | `VersionGateway`, `VersionBar`, pin por ejecución, "editar no altera ejecuciones en vuelo" en **E8** (§10.1). |
| Sin dry-run/test de workflows del usuario | Modo simulación con `ToolInvoker` mock + fixtures + asserts en **E8** (§11, §12). |
| Observabilidad del Orchestrator llega después de de-riesgarlo | Vista básica del árbol de plan en **E5**, co-requisito de de-riesgar P2, sobre el mismo contrato de eventos (§8.4, §12). |
| Tools peligrosas sin sandbox durante de-riesgado | Badge `requiresSandbox` + `issue` bloqueante si no hay aislamiento; el editor refleja la restricción (§4, §12). |

---

Documento autocontenido y accionable. Puntos de anclaje para implementación: el `NodeTypeRegistry` (§3) y el contrato `ExecutionEvent`/reducer (§8) son las dos piezas que hay que fijar primero, porque de ellas cuelgan la extensibilidad (P1) y la observabilidad del Orchestrator (P2) respectivamente.
