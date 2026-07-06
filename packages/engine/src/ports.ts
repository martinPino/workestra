import type {
  Execution,
  ExecutionStatus,
  ExecutionContext,
  ExecutionEvent,
  NodeType,
  INodeExecutor,
  WorkflowGraph,
  Agent,
  MemoryScope,
} from '@core/contracts';

/**
 * Puertos hexagonales del motor. El `WorkflowRunner` depende SOLO de estas interfaces;
 * los adaptadores concretos (Prisma/Redis/BullMQ) viven en `@core/infra` y se inyectan.
 */

export interface NewExecution {
  workflowVersionId: string;
  workspaceId: string;
  parentExecutionId?: string | null;
  triggerType: string;
  context: ExecutionContext;
}

export interface NewExecutionLog {
  executionId: string;
  nodeKey: string;
  stepKey: string;
  level: string;
  status: string;
  input?: unknown;
  output?: unknown;
  tokens?: number;
  cost?: number;
  durationMs?: number;
}

export interface ExecutionListQuery {
  workspaceId: string;
  status?: ExecutionStatus;
  limit?: number;
}

export interface IExecutionRepository {
  create(e: NewExecution): Promise<Execution>;
  get(id: string): Promise<Execution | null>;
  /** Lista ejecuciones del workspace (más recientes primero), opcionalmente filtradas por estado. */
  list(q: ExecutionListQuery): Promise<Execution[]>;
  updateStatus(id: string, status: ExecutionStatus): Promise<void>;
  appendLog(log: NewExecutionLog): Promise<void>;
  /** Acumula consumo (tokens/coste) de un nodo en la ejecución. */
  addUsage(id: string, tokens: number, cost: number): Promise<void>;
}

/** Redis en producción; in-memory en tests. */
export interface IContextStore {
  load(execId: string): Promise<ExecutionContext>;
  checkpoint(execId: string, ctx: ExecutionContext): Promise<void>;
}

export interface IEventPublisher {
  publish(e: ExecutionEvent): Promise<void>;
}

// --------- Puerto de persistencia del stream de eventos (M6: observabilidad/replay) ---------

/**
 * Almacén APPEND-ONLY del stream versionado de `ExecutionEvent`. Es la fuente de verdad del replay:
 * `append` es IDEMPOTENTE por (executionId, seq) — reintentos del worker o el doble camino
 * worker→Redis→hub no duplican eventos—, `list` devuelve el stream completo ordenado por seq y
 * `lastSeq` permite CONTINUAR la numeración al reanudar (pausa humana / crash) sin colisiones.
 */
export interface IEventStore {
  append(e: ExecutionEvent): Promise<void>;
  /**
   * Devuelve el stream ordenado por seq. Con `sinceSeq` retorna SOLO los eventos con `seq > sinceSeq`
   * (delta-fetch, M9): permite a la consola sondear incrementalmente sin re-transferir el historial.
   * Por defecto (`-1`) devuelve el stream completo.
   */
  list(executionId: string, sinceSeq?: number): Promise<ExecutionEvent[]>;
  /** Mayor seq persistido para la ejecución; -1 si aún no hay eventos. */
  lastSeq(executionId: string): Promise<number>;
}

/** Resuelve el ejecutor de un tipo de nodo. Añadir tipos = registrar, sin tocar el runner. */
export interface INodeExecutorRegistry {
  get(type: NodeType): INodeExecutor | undefined;
}

export interface IClock {
  now(): Date;
}

export interface IIdGenerator {
  next(): string;
}

// --------- Puertos de persistencia de workflows (capa de aplicación) ---------

export interface WorkflowRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  currentVersionId: string | null;
  version: number;
}

export interface WorkflowWithGraph extends WorkflowRecord {
  graph: WorkflowGraph;
}

export type WorkflowVersionState = 'draft' | 'published' | 'archived';

export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  version: number;
  state: WorkflowVersionState;
  graph: WorkflowGraph;
  publishedAt: string | null;
}

/**
 * Ciclo de vida de versiones (M4p): `get`/`saveGraph` operan sobre el DRAFT (mutable). `publish`
 * congela el draft en una versión INMUTABLE `published`. Las ejecuciones se anclan a la versión
 * con la que arrancaron (`resolveRunVersion`), de modo que editar/publicar después no las altera.
 */
export interface IWorkflowRepository {
  create(input: { workspaceId: string; name: string; graph?: WorkflowGraph }): Promise<WorkflowWithGraph>;
  list(workspaceId: string): Promise<WorkflowRecord[]>;
  /** Devuelve el grafo del DRAFT (lo que edita el editor). */
  get(id: string): Promise<WorkflowWithGraph | null>;
  /** Guarda el grafo del DRAFT (no crea versión). */
  saveGraph(id: string, graph: WorkflowGraph): Promise<WorkflowWithGraph>;
  /** Congela el draft en una versión inmutable `published` y la marca como activa. */
  publish(id: string): Promise<WorkflowVersionRecord>;
  listVersions(id: string): Promise<WorkflowVersionRecord[]>;
  getVersion(versionId: string): Promise<WorkflowVersionRecord | null>;
  /** Versión a ejecutar: la published activa; si no hay ninguna, publica el draft y la usa. */
  resolveRunVersion(id: string): Promise<WorkflowVersionRecord>;
}

// --------- Puerto de proyección NodeRun (estado runtime por nodo) ---------

export interface NodeRunUpsert {
  executionId: string;
  nodeKey: string;
  status: string;
  attempt?: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface INodeRunRepository {
  upsert(run: NodeRunUpsert): Promise<void>;
  list(executionId: string): Promise<Array<{ nodeKey: string; status: string }>>;
}

// --------- Puerto de registro de agentes ---------

export interface IAgentRepository {
  list(workspaceId: string): Promise<Agent[]>;
  get(id: string): Promise<Agent | null>;
  /** Como `get`, pero devuelve el agente SOLO si pertenece al workspace (aislamiento por tenant, M8). */
  getInWorkspace(id: string, workspaceId: string): Promise<Agent | null>;
  create(input: Omit<Agent, 'id'> & { workspaceId: string }): Promise<Agent>;
  /** Aplica un patch parcial SOLO si el agente es del workspace; devuelve el agente actualizado o null. */
  update(id: string, workspaceId: string, patch: Partial<Omit<Agent, 'id'>>): Promise<Agent | null>;
  /** Borra el agente SOLO si es del workspace (deny-by-default por tenant). `true` si se borró. */
  delete(id: string, workspaceId: string): Promise<boolean>;
}

// --------- Puerto de revisiones humanas (escalado / human-in-the-loop, M5) ---------

export type PendingReviewStatus = 'pending' | 'approved' | 'rejected';

export interface PendingReviewRecord {
  id: string;
  executionId: string;
  nodeKey: string;
  status: PendingReviewStatus;
  reason: string;
  decision: string | null;
  resolvedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/**
 * Puerto de revisiones humanas pendientes. El nodo Humano pausa la ejecución creando una revisión
 * `pending` (idempotente por (executionId, nodeKey)); al reanudar re-lee su estado para decidir
 * continuar/terminar. La resolución (aprobar/rechazar) es idempotente: solo transiciona una vez.
 */
export interface IPendingReviewRepository {
  /** Idempotente: devuelve la revisión de ese nodo si ya existe (re-entrada tras reanudar). */
  findByNode(executionId: string, nodeKey: string): Promise<PendingReviewRecord | null>;
  create(input: { executionId: string; nodeKey: string; reason: string; expiresAt?: string | null }): Promise<PendingReviewRecord>;
  get(id: string): Promise<PendingReviewRecord | null>;
  listByExecution(executionId: string): Promise<PendingReviewRecord[]>;
  /**
   * Transiciona la revisión SOLO si sigue `pending`. Devuelve el registro final y `transitioned`:
   * true si ESTA llamada fue la que la resolvió, false si ya estaba resuelta (carrera perdida). El
   * llamante usa `transitioned` para emitir eventos / reanudar UNA sola vez (idempotencia concurrente).
   */
  resolve(
    id: string,
    decision: { approved: boolean; resolvedBy: string; decision: string },
  ): Promise<{ record: PendingReviewRecord; transitioned: boolean }>;
}

// --------- Puerto de webhooks (triggers entrantes, M7) ---------

export interface WebhookRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  /** Tipo de disparador declarado (p. ej. 'webhook'). */
  event: string;
  /** Ruta pública de ingreso, p. ej. `/hooks/<id>`. */
  url: string;
  /** Clave del secreto de firma en el `ISecretStore` (el valor nunca se persiste en claro). */
  signingSecretKey: string;
  active: boolean;
}

/** Registro de webhooks: un workflow puede exponer varios endpoints de ingreso firmados. */
export interface IWebhookRepository {
  create(input: {
    workspaceId: string;
    workflowId: string;
    event: string;
    url: string;
    signingSecretKey: string;
  }): Promise<WebhookRecord>;
  get(id: string): Promise<WebhookRecord | null>;
  listByWorkflow(workflowId: string): Promise<WebhookRecord[]>;
  setUrlAndSecret(id: string, url: string, signingSecretKey: string): Promise<WebhookRecord>;
  delete(id: string): Promise<void>;
}

// --------- Puerto de triggers programados (cron/intervalo, M7-B) ---------

export interface ScheduleRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  /** Patrón cron de 5 campos (excluyente con `everyMs`). */
  cron: string | null;
  /** Intervalo en ms (excluyente con `cron`). */
  everyMs: number | null;
  active: boolean;
  createdAt: string;
}

/** Registro durable de triggers programados (la planificación real vive en BullMQ). */
export interface IScheduleRepository {
  create(input: { workspaceId: string; workflowId: string; cron: string | null; everyMs: number | null }): Promise<ScheduleRecord>;
  get(id: string): Promise<ScheduleRecord | null>;
  listByWorkflow(workflowId: string): Promise<ScheduleRecord[]>;
  /** Todos los schedules activos (para re-registrar los repeatables al arrancar). */
  listActive(): Promise<ScheduleRecord[]>;
  delete(id: string): Promise<void>;
}

// --------- Puerto de conectores (integraciones OAuth salientes, M11) ---------

export interface ConnectorRecord {
  id: string;
  workspaceId: string;
  /** Clave única del conector dentro del workspace (p. ej. "dev-1"). */
  key: string;
  /** Proveedor del catálogo (`dev`, `github`, `slack`, …). */
  provider: string;
  status: 'disconnected' | 'connected';
  /** Clave del token OAuth en el `ISecretStore` (null hasta completar el connect). */
  credentialsSecretId: string | null;
}

/**
 * Registro de conectores por workspace. El TOKEN OAuth nunca se persiste aquí en claro: se guarda
 * cifrado en el `ISecretStore` y solo se referencia por `credentialsSecretId`.
 */
export interface IConnectorRepository {
  create(input: { workspaceId: string; key: string; provider: string }): Promise<ConnectorRecord>;
  /** Deny-by-default por tenant: nunca resuelve un conector de otro workspace. */
  getInWorkspace(id: string, workspaceId: string): Promise<ConnectorRecord | null>;
  listByWorkspace(workspaceId: string): Promise<ConnectorRecord[]>;
  /** Marca el conector como conectado y fija la clave del token cifrado. */
  setConnected(id: string, credentialsSecretId: string): Promise<void>;
  delete(id: string): Promise<ConnectorRecord | null>;
}

// --------- Puerto de bindings de disparador (triggers sin código, M19) ---------

export interface TriggerBindingRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  /** Receta del catálogo, p. ej. 'jira.issue_created'. */
  eventId: string;
  /** Conector OAuth usado para registrar el webhook en el proveedor. */
  connectorId: string;
  /** Webhook interno de ingreso (`/hooks/<webhookId>`) que arranca la ejecución. */
  webhookId: string;
  /** Id(s) del webhook creado EN el proveedor (CSV), para poder borrarlo/renovarlo. */
  remoteId: string | null;
  /** Parámetros de la receta: { projectKey, cloudId, … }. */
  params: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}

/**
 * Registro durable del enlace disparador↔workflow (M19). Cuando el usuario elige «Cuando se crea un
 * ticket de Jira», guardamos aquí el webhook interno + el id del webhook creado en el proveedor.
 */
export interface ITriggerBindingRepository {
  create(input: {
    workspaceId: string;
    workflowId: string;
    eventId: string;
    connectorId: string;
    webhookId: string;
    remoteId: string | null;
    params: Record<string, unknown>;
  }): Promise<TriggerBindingRecord>;
  get(id: string): Promise<TriggerBindingRecord | null>;
  listByWorkflow(workflowId: string): Promise<TriggerBindingRecord[]>;
  /** Todos los bindings activos (para el job que renueva los webhooks antes de caducar). */
  listActive(): Promise<TriggerBindingRecord[]>;
  setActive(id: string, active: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}

// --------- Puerto de secretos (credenciales cifradas en reposo, M7) ---------

/**
 * Almacén de secretos por workspace. El valor se guarda CIFRADO en reposo (AES-GCM); `get`
 * devuelve el texto claro descifrado. Deny-by-default por tenant: cada operación se acota a un
 * `workspaceId`. Sirve para firmas de webhooks, credenciales de conectores y claves de proveedor.
 */
export interface ISecretStore {
  set(workspaceId: string, key: string, plaintext: string): Promise<void>;
  get(workspaceId: string, key: string): Promise<string | null>;
  /** Lista las CLAVES (nunca los valores) del workspace. */
  list(workspaceId: string): Promise<string[]>;
  delete(workspaceId: string, key: string): Promise<void>;
}

// --------- Puerto de memoria (temporal/persistente/compartida) ---------

export interface IMemoryStore {
  get(scope: MemoryScope, ownerId: string, key: string): Promise<unknown | undefined>;
  set(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void>;
  append(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void>;
}
