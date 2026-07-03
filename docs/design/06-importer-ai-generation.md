# Area: Importador de automatizaciones y Generacion por IA

## 1. Objetivo y principio rector

Esta area entrega dos rutas para **crear** un workflow que luego el usuario edita en el canvas:

1. **Importador multi-fuente**: convierte automatizaciones existentes (Jira Automation, n8n, LangGraph, CrewAI, BPMN, Mermaid, JSON personalizado) en un workflow editable.
2. **Generacion por IA**: convierte una descripcion en lenguaje natural en un workflow editable.

**Decision arquitectonica central**: ambas rutas **convergen en una Representacion Intermedia (IR) canonica** y comparten todo el tramo aguas abajo (mapeo a grafo, validacion, auto-layout, reporte). El LLM de la generacion IA no es mas que "otra fuente" que produce IR, restringida por schema.

```
Importador:   RawArtifact --[SourceImporter]--> IR --\
                                                       >--[IrToGraphMapper]--[GraphValidator]--[AutoLayout]--> WorkflowDraft + ImportReport
Generacion:   NL prompt   --[LLM estructurado]--> IR --/
```

Beneficios: **Open/Closed** (anadir una fuente = un plugin, nada del nucleo cambia), **DRY** (una sola validacion/layout/reporte), y **de-riesgo temprano** (el tramo compartido se construye una vez).

---

## 2. Representacion Intermedia (IR) canonica

La IR es la **unica frontera estable** entre fuentes y destino. Es neutral respecto a origen y a destino, versionada por `schemaVersion`, y preserva integramente lo no modelado en `rawPayload` para no perder informacion nunca.

```ts
type IrDocument = {
  schemaVersion: string;              // p.ej. "ir/1.2.0"
  source: SourceMeta;                 // { format, tool, version, importedAt }
  nodes: IrNode[];
  edges: IrEdge[];
  variables: IrVariable[];
  diagnostics: IrDiagnostic[];        // avisos producidos en parse/normalize
};

type IrNodeKind =
  | 'trigger' | 'agent' | 'condition' | 'loop' | 'wait'
  | 'tool' | 'api' | 'llm' | 'memory' | 'human' | 'end'
  | 'subworkflow' | 'unknown';        // 'unknown' => fallback

type IrNode = {
  irId: string;                       // id estable dentro del IrDocument
  kind: IrNodeKind;
  label?: string;
  logical: Record<string, unknown>;   // semantica normalizada (p.ej. condition.expr)
  ports?: IrPort[];                   // puertos logicos (in/out, ramas)
  position?: { x: number; y: number }; // presente solo en fuentes visuales
  rawPayload: unknown;                // payload de origen INTACTO (no se pierde nada)
  sourceRef: SourceRef;               // trazabilidad: { format, nativeId, path }
};

type IrEdge = {
  irId: string;
  from: { node: string; port?: string };
  to:   { node: string; port?: string };
  condition?: string;                 // expresion normalizada opcional (ramas)
  rawPayload?: unknown;
};
```

Regla de oro: **todo lo que una fuente exprese y no encaje en `logical` se conserva en `rawPayload`** y se materializa como `GenericNode`/`Comment` con una entrada en el `ImportReport`.

---

## 3. Importador: contrato de plugin por fuente

Cada fuente implementa **una** interfaz. Anadir un formato = registrar una nueva implementacion; el nucleo no se toca.

```ts
type SourceFormat =
  | 'jira-automation' | 'n8n' | 'langgraph' | 'crewai'
  | 'bpmn' | 'mermaid' | 'custom-json';

interface SourceImporter {
  readonly id: SourceFormat;
  readonly version: string;                       // version del importer
  readonly schemaVersionSupported: string;        // IR que emite

  /** Auto-deteccion: 0..1 de confianza de que este importer aplica */
  sniff(raw: RawArtifact): ConfidenceScore;

  /** Parseo sintactico del artefacto crudo a un AST especifico de la fuente */
  parse(raw: RawArtifact, opts: ImportOptions): Promise<ParsedSource>;

  /** Normalizacion del AST a IR canonica (aqui vive el conocimiento de la fuente) */
  normalize(parsed: ParsedSource, ctx: ImportContext): Promise<IrDocument>;

  /** Declaracion de cobertura/limitaciones para el reporte y la UI */
  capabilities(): ImporterCapabilities;
}

interface ImporterRegistry {
  register(imp: SourceImporter): void;
  resolve(format?: SourceFormat, raw?: RawArtifact): SourceImporter; // explicito o por sniff
  list(): ImporterDescriptor[];
}
```

`ImporterCapabilities` declara que construcciones de la fuente estan soportadas, degradadas o no soportadas — alimenta el `ImportReport` y la UI de expectativas.

---

## 4. Tramo compartido aguas abajo (reutilizado por import y por IA)

### 4.1 IrToGraphMapper + estrategia por regla

```ts
interface IrToGraphMapper {
  map(ir: IrDocument, ctx: MappingContext): Promise<MappingResult>;
}
type MappingResult = { graph: WorkflowGraph; report: ImportReport };

/** Una regla por (formato?, kind). Registrable, con prioridad. */
interface MappingRule {
  readonly match: { format?: SourceFormat; kind: IrNodeKind };
  readonly priority: number;
  apply(node: IrNode, ctx: MappingContext): MappedNode | Degraded;
}

interface NodeTypeResolver {
  resolve(node: IrNode, ctx: MappingContext): MappingRule | null; // null => fallback
}
```

- Si una `MappingRule` aplica: produce un `Node` real (tipo del `NodeRegistry`) con su `config` transformada.
- Si ninguna aplica o la config no valida: **fallback** a `GenericNode` (nodo generico deshabilitado que porta `rawPayload`) o `Comment`, y se registra como *degradado* en el reporte.
- El mapper **no conoce fuentes concretas**: resuelve por registro (Open/Closed).

### 4.2 NodeRegistry (dependencia compartida, no propia de esta area)

Fuente unica de verdad de tipos de nodo y sus JSON Schemas. Esta area lo **consume**; lo poseen el motor/editor.

```ts
interface NodeRegistry {
  getSchema(type: NodeType): NodeSchema;        // JSON Schema de config + puertos
  list(): NodeDescriptor[];
  validateConfig(type: NodeType, cfg: unknown): ValidationResult;
}
```

### 4.3 GraphValidator (DAG + esquemas)

```ts
interface GraphValidator {
  validate(graph: WorkflowGraph, ctx: ValidationContext): GraphValidationResult;
}
type GraphValidationResult = {
  ok: boolean;
  errors: GraphError[];     // ciclos, puertos incompatibles, config invalida, refs inexistentes
  warnings: GraphWarning[]; // degradaciones tolerables
};
```

Comprueba: aciclicidad (DAG), conectividad, compatibilidad de puertos, cardinalidad, `config` de cada nodo contra su `NodeSchema`, y que `agentId`/`toolId`/`connectorId` **existan** en el workspace.

### 4.4 AutoLayoutEngine

```ts
interface AutoLayoutEngine {
  layout(graph: WorkflowGraph, opts: LayoutOptions): PositionedGraph;
}
```

Usa layout jerarquico dirigido (dagre/ELK). Si la fuente ya trae coordenadas (BPMN/n8n/Mermaid) las respeta segun `LayoutOptions.preserveSourcePositions`.

### 4.5 ImportReportBuilder

```ts
type ImportReport = {
  coverage: number;                 // 0..1
  mapped:   MappedItem[];           // sourceRef -> nodeId (1:1)
  degraded: DegradedItem[];         // a GenericNode/Comment, con motivo
  unmapped: UnmappedItem[];         // construcciones ignoradas
  warnings: Warning[];
};
interface ImportReportBuilder { note(e: ReportEntry): void; build(): ImportReport; }
```

Es el entregable de **transparencia**: el usuario ve exactamente que se mapeo 1:1, que se degrado y por que.

---

## 5. Generacion por IA (boton "Generate Workflow")

La IA reutiliza **todo** el tramo del punto 4. Su unico aporte es producir IR valida desde NL, con guardrails.

### 5.1 Servicio y schema derivado del registro

```ts
interface WorkflowGenerationService {
  generate(req: GenerateRequest): Promise<GenerationResult>;
}
type GenerateRequest = {
  prompt: string;
  workspaceId: string;
  allowedNodeTypes?: NodeType[];      // por defecto: todos los del registro
  availableAgents: AgentRef[];        // del workspace
  availableTools: ToolRef[];          // del workspace
};

/** Deriva el JSON Schema de salida del LLM desde el registro y el workspace. */
interface GenerationSchemaBuilder {
  build(ctx: GenerationContext): JSONSchema; // enums de NodeType/agentId/toolId
}

interface StructuredLlmClient {
  complete<T>(req: {
    messages: ChatMessage[];
    jsonSchema: JSONSchema;           // salida estructurada forzada
    model: string;
    temperature: number;
  }): Promise<{ value: T; usage: TokenUsage }>;
}
```

**Guardrail estructural (clave)**: el schema de salida **enumera** los `NodeType`, `agentId` y `toolId` que realmente existen. El modelo *no puede* emitir un tipo/tool/agente inexistente porque el schema lo prohibe — no dependemos solo del prompt.

### 5.2 Guardrails semanticos y auto-reparacion

```ts
interface GenerationGuardrails {
  enforce(ir: IrDocument, ctx: GenerationContext):
    { ir: IrDocument; violations: Violation[]; repairable: boolean };
}
```

Flujo:

1. Construir prompt: system con reglas + **contexto del registro** (nodos, agentes, tools disponibles con descripcion) + **few-shot** (2-3 ejemplos NL->IR extraidos de importaciones reales).
2. `StructuredLlmClient.complete` con el schema derivado.
3. `GenerationGuardrails.enforce`: allowlist, corte de ciclos, poda de aristas huerfanas, limite de tamano.
4. `IrToGraphMapper` -> `GraphValidator`.
5. Si hay errores y `repairable`: **bucle de auto-reparacion** — se devuelven al LLM los errores del validador como feedback y se reintenta (N acotado).
6. `AutoLayout` -> `WorkflowDraft` + `ImportReport`.
7. Streaming incremental del grafo por WS para percepcion de rapidez.

### 5.3 Diseno de prompt (esqueleto)

```
[system]
Eres un generador de workflows. SOLO puedes usar los siguientes tipos de nodo,
agentes y herramientas (lista inyectada del registro). NUNCA inventes otros.
Devuelve unicamente IR valida segun el schema. El grafo debe ser un DAG.
[few-shot] NL -> IR (2-3 ejemplos)
[user] <descripcion en lenguaje natural>
```

---

## 6. Orquestacion (capa de aplicacion) y API

```ts
interface ImportOrchestrator { import(cmd: ImportCommand): Promise<ImportResultDto>; }
```

Pipeline de aplicacion (aislado del dominio, apto para cola BullMQ):
`resolve importer -> parse -> normalize -> map -> validate -> layout -> persistir draft -> emitir report`.

### Endpoints REST/WS

| Metodo | Ruta | Descripcion |
|---|---|---|
| POST | `/workflows/import` | Encola import; `202 { importJobId }` |
| GET | `/workflows/import/{id}` | Estado + `workflowDraftId` + `report` |
| POST | `/workflows/import/preview` | Mapeo sincrono sin persistir (dry-run) |
| GET | `/importers` | Lista de `SourceImporter` y capabilities |
| POST | `/workflows/generate` | Encola generacion IA; `202 { generationJobId }` |
| GET | `/workflows/generate/{id}` | Estado + draft + report + tokens + coste |
| POST | `/workflows/generate/refine` | Re-generacion conversacional con feedback |
| WS | canal `import`/`generate` | `import.progress`, `import.node.mapped`, `generate.token.delta`, `*.completed` |

**SPI de plugin**: registrar `SourceImporter` y `MappingRule` sin desplegar el nucleo.

---

## 7. Persistencia (tablas)

- **ImportJob** `(id, workspaceId, userId, sourceFormat, status, rawArtifactRef, irSchemaVersion, resultWorkflowId, reportId, createdAt, finishedAt, error)`
- **GenerationJob** `(id, workspaceId, userId, prompt, model, status, irSchemaVersion, resultWorkflowId, reportId, tokenUsage jsonb, costEstimate, attempts, createdAt, finishedAt)`
- **ImportReport** `(id, importJobId?, generationJobId?, coverage, mappedCount, degradedCount, unmappedCount, entries jsonb, warnings jsonb, createdAt)`
- **ImporterPlugin** `(id, sourceFormat, displayName, version, enabled, capabilities jsonb, schemaVersionSupported)`
- **MappingRuleRecord** (opcional/configurable) `(id, sourceFormat, irKind, targetNodeType, priority, transformSpec jsonb, enabled)`

El resultado se materializa como una **WorkflowVersion draft** con sus `Node`/`Edge` del nucleo; cada `Node.metadata.sourceRef` conserva la provenance hacia el elemento de origen.

---

## 8. Estrategia de cobertura y fidelidad

- **Fidelidad graduada por elemento**: cada construccion de origen se clasifica en *mapeado 1:1*, *degradado* (a `GenericNode`/`Comment`, conservando `rawPayload`) o *no mapeado*. Nunca falla el import completo por un elemento no soportado.
- **Fallback siempre trazable**: lo degradado queda visible en el canvas (nodo generico/comentario) y en el reporte, con el `sourceRef` para que el usuario lo complete a mano.
- **Ciclos hacia un motor DAG**: los bucles de n8n/LangGraph se materializan como nodos `Bucle`/`Espera` con limites, o se marcan como advertencia sugiriendo subworkflow; nunca se persiste un grafo ciclico en silencio.
- **Golden-file tests** por fuente para medir cobertura real y evitar regresiones.

---

## 9. Cumplimiento SOLID / Clean Architecture

- **SRP**: parse (sintaxis) separado de normalize (semantica) separado de map (destino) separado de validate/layout/report.
- **OCP**: nuevas fuentes via `SourceImporter`+`MappingRule` registrables; el mapper/validador no cambian.
- **LSP/ISP**: interfaces pequenas y sustituibles (`SourceImporter`, `MappingRule`, `AutoLayoutEngine`, `StructuredLlmClient`).
- **DIP**: la capa de aplicacion depende de interfaces (`NodeRegistry`, `StructuredLlmClient`, `ImporterRegistry`), no de implementaciones concretas ni de un proveedor LLM.
- **Frontera IR**: aisla completamente "de donde viene" de "a que se traduce", y hace que la generacion IA sea un caso mas del mismo pipeline.
