import type {
  Execution,
  ExecutionStatus,
  ExecutionContext,
  ExecutionEvent,
  NodeType,
  INodeExecutor,
  WorkflowGraph,
  Agent,
  McpServerRef,
  MemoryScope,
  Role,
} from '@core/contracts';

/**
 * Herramienta expuesta por un servidor MCP externo (M40): nombre + descripción + esquema de parámetros y una
 * función para invocarla. El AgentRuntime la ofrece al modelo y enruta las llamadas a través de `invoke`.
 */
export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Resuelve los servidores MCP enganchados a un agente en herramientas invocables (M40). Se conecta a cada
 * servidor, lista sus tools y devuelve adaptadores `McpTool`. Un servidor inalcanzable no rompe la ejecución:
 * sus tools simplemente se omiten. Puerto puro: la implementación (cliente MCP) vive en infra.
 */
export interface IMcpToolResolver {
  resolve(workspaceId: string, servers: McpServerRef[]): Promise<McpTool[]>;
}

/** Referencia a un fichero guardado (M48): metadatos ligeros que viajan en el contexto (no los bytes). */
export interface FileRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Fichero completo (metadatos + bytes) recuperado del almacén. */
export interface StoredFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Almacén de ficheros de un workspace (M48): guarda bytes fuera del contexto (que es JSON y se persiste) para
 * poder mover ficheros/PDFs entre nodos. Los bytes viven con TTL en Redis (efímeros, como en n8n); el contexto
 * solo lleva una `FileRef` ligera. Adaptadores en infra (Redis + InMemory).
 */
export interface IFileStore {
  put(workspaceId: string, file: StoredFile): Promise<FileRef>;
  get(workspaceId: string, id: string): Promise<StoredFile | null>;
}

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
  /** Filtra a estas versiones (todas las de un workflow). Aplicado ANTES del límite en AMBOS adaptadores. */
  workflowVersionIds?: string[];
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
  /**
   * Borra el workflow y TODA su historia (versiones, nodos/aristas, webhooks, horarios, disparadores y
   * ejecuciones con sus eventos). La comprobación de pertenencia al workspace la hace el servicio.
   */
  delete(id: string): Promise<void>;
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

/** M52: config de SONDEO de un schedule (p. ej. «Google Drive: nuevo fichero»): al disparar, lista y encola. */
export interface SchedulePoll {
  provider: string; // p. ej. 'google-drive'
  connectorId: string; // conector conectado del que sacar el token
  folderId?: string; // carpeta a vigilar (opcional)
}

export interface ScheduleRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  /** Patrón cron de 5 campos (excluyente con `everyMs`). */
  cron: string | null;
  /** Intervalo en ms (excluyente con `cron`). */
  everyMs: number | null;
  /** M52: si está presente, al disparar se SONDEA la fuente y se encola una ejecución por cada ítem nuevo. */
  poll?: SchedulePoll | null;
  active: boolean;
  createdAt: string;
}

/** Registro durable de triggers programados (la planificación real vive en BullMQ). */
export interface IScheduleRepository {
  create(input: { workspaceId: string; workflowId: string; cron: string | null; everyMs: number | null; poll?: SchedulePoll | null }): Promise<ScheduleRecord>;
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
  /** Todos los bindings de un conector (cross-workspace, para enrutar el ingreso público del proveedor). */
  listByConnector(connectorId: string): Promise<TriggerBindingRecord[]>;
  /** Todos los bindings activos (para el job que renueva los webhooks antes de caducar). */
  listActive(): Promise<TriggerBindingRecord[]>;
  /** Fija el id del webhook remoto tras (re)registrar en el proveedor. */
  setRemoteId(id: string, remoteId: string | null): Promise<void>;
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

// --------- Puerto de claves de API (credencial duradera para MCP / apps externas, M32) ---------

export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  /** `sub` del principal (para req.user). */
  userSub: string;
  /** Snapshot del email al crear la clave (para whoami/listado). */
  email: string;
  /** Snapshot del rol al crear la clave: dirige el RBAC de todo lo que haga la clave. */
  role: Role;
  /** sha256(raw) hex. La clave en claro (`af_…`) NUNCA se persiste. */
  hashedKey: string;
  prefix: string;
  last4: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Claves de API por workspace (M32). La clave en claro se muestra UNA vez al crearla; aquí solo vive su
 * hash. `findByHash` devuelve solo claves ACTIVAS (no revocadas) — es el punto de entrada de la auth por key.
 */
export interface IApiKeyRepository {
  create(input: {
    workspaceId: string;
    userSub: string;
    email: string;
    role: Role;
    hashedKey: string;
    prefix: string;
    last4: string;
    label: string;
  }): Promise<ApiKeyRecord>;
  /** Solo claves activas (revokedAt = null). Es el lookup de autenticación. */
  findByHash(hashedKey: string): Promise<ApiKeyRecord | null>;
  listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]>;
  /** Revoca (marca revokedAt) solo si pertenece al workspace. Devuelve la fila o null. */
  revoke(id: string, workspaceId: string): Promise<ApiKeyRecord | null>;
  /** Best-effort: sella el último uso (no debe bloquear la petición si falla). */
  touchLastUsed(id: string): Promise<void>;
}

// --------- Puerto de uso/cuota por workspace (M33) ---------

/**
 * Contador de tokens LLM por workspace en una VENTANA DIARIA (se resetea cada día). Sirve para que un
 * workspace no agote el presupuesto común: se consulta antes de una operación de IA y se suma después.
 * El adaptador Redis usa una clave por día con TTL (auto-reset); el InMemory, un Map por día.
 */
export interface IWorkspaceUsageRepository {
  /** Suma `tokens` al contador de HOY del workspace y devuelve el nuevo total del día. */
  add(workspaceId: string, tokens: number): Promise<number>;
  /** Tokens LLM usados HOY por el workspace. */
  todayTokens(workspaceId: string): Promise<number>;
}
