import type {
  WorkflowGraph,
  ExecutionEvent,
  ActiveUsersRow,
  EntityRow,
  EntityType,
  ErrorRow,
  EventName,
  FeatureUsageRow,
  FunnelRow,
  RetentionRow,
  SearchRow,
  SessionsRow,
  SurfaceRow,
  TabDwellRow,
  CreateShareRequest,
  CreateShareResponse,
  SharePreviewResponse,
} from '@core/contracts';
import { currentToken, ensureDevSession, AUTH_MODE, useAuth, type Role, type SessionUser } from './auth';
// M84: `api` no es un componente, así que no puede usar el hook; se emite con `track` a pelo.
// El transporte de analítica usa `fetch` global (no este envoltorio), así que no hay ciclo.
import { track } from '../analytics/tracker';

// Normaliza: quita barra(s) final(es) para no generar `//ruta` (que en Nest da 404).
const API = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');

export interface WorkflowDto {
  id: string;
  name: string;
  status: string;
  version: number;
  currentVersionId: string | null;
  graph: WorkflowGraph;
}

/** Clave de IA propia del workspace (BYOK, M35): solo el proveedor y los últimos 4 chars. */
export interface LlmKeyView {
  provider: string;
  last4: string;
}

/** Vista de una clave de API (M32): sin hash ni clave en claro. */
export interface ApiKeyView {
  id: string;
  prefix: string;
  last4: string;
  label: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ExecutionRow {
  id: string;
  status: string;
  triggerType: string;
  tokensUsed: number;
  costEstimate: number;
  workflowVersionId: string;
  /** Workflow al que pertenece la ejecución (resuelto por la versión anclada). */
  workflowId?: string | null;
  workflowName?: string | null;
  createdAt?: string | null;
}

/** Receta de disparador activa (M19): enlace workflow↔evento externo con auto-registro en el proveedor. */
export interface TriggerBindingDto {
  id: string;
  workflowId: string;
  eventId: string;
  connectorId: string;
  webhookId: string;
  remoteId: string | null;
  params: { projectKey?: string; cloudId?: string } & Record<string, unknown>;
  active: boolean;
  createdAt: string;
}

export interface ReviewDto {
  id: string;
  executionId: string;
  nodeKey: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  decision: string | null;
  resolvedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Miembro del equipo (M74). Fechas como ISO string. */
export interface TeamMemberDto {
  userId: string;
  email: string;
  name: string;
  role: Role;
  disabledAt: string | null;
  joinedAt: string;
}
/** Invitación pendiente (M74). */
export interface TeamInvitationDto {
  id: string;
  email: string;
  role: Role;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}
export interface TeamDataDto {
  members: TeamMemberDto[];
  invitations: TeamInvitationDto[];
  emailConfigured: boolean;
  me: { userId: string; role: Role };
}

/** Detalle de una ejecución (M6): grafo anclado + stream durable de eventos para el replay. */
export interface ExecutionDetailDto {
  executionId: string;
  execution: {
    id: string;
    status: string;
    triggerType: string;
    tokensUsed: number;
    costEstimate: number;
    workflowVersionId: string;
  } | null;
  version: { id: string; version: number; graph: WorkflowGraph } | null;
  nodeRuns: Array<{ nodeKey: string; status: string }>;
  context: Record<string, unknown>;
  reviews: ReviewDto[];
  events: ExecutionEvent[];
}

export interface McpServerRef {
  id: string;
  name: string;
  url: string;
}

export interface AgentDto {
  id: string;
  name: string;
  description?: string | null;
  systemPrompt?: string;
  model: string;
  tools: string[];
  mcpServers?: McpServerRef[] | null;
  /** M81: memoria del agente. `null` = apagada; ver `MEMORY_MODES` en lib/memory. */
  memoryScope?: string | null;
  isOrchestrator: boolean;
  permissions?: { role?: string } | null;
}

/** Campos que acepta crear/editar un agente. `name` = Rol, `description` = Objetivo, `systemPrompt` = Instrucciones. */
export interface AgentInput {
  name: string;
  description?: string | null;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  mcpServers?: Array<{ id?: string; name: string; url: string }>;
  /** M81: `null`/omitido = memoria apagada; 'temporal' | 'persistent' | 'shared'. */
  memoryScope?: string | null;
  isOrchestrator?: boolean;
}

/** Borrador de agente que propone la IA (M68) para rellenar el formulario. Forma canónica del agente. */
export interface AgentDraft {
  name: string;
  description?: string | null;
  systemPrompt: string;
  model: string;
  tools: string[];
  isOrchestrator: boolean;
}

/** Resumen del panel de analítica (M84): lo que devuelve `GET /insights/overview` de una tacada. */
export interface InsightsOverviewDto {
  surfaces: SurfaceRow[];
  tabs: TabDwellRow[];
  sessions: SessionsRow;
  active: ActiveUsersRow[];
  errors: ErrorRow[];
}

/**
 * Ventana del panel de analítica (M84).
 *
 * `scope: 'all'` cruza TODOS los workspaces y el backend solo se lo consiente a un administrador de
 * plataforma (si no, 400). Sin él, la API usa el workspace de la sesión verificada: el ámbito nunca sale
 * de aquí, así que mandar el parámetro no es lo que da permiso.
 */
export interface InsightsQuery {
  days: number;
  scope?: 'all';
}

const insightsQs = (q: InsightsQuery, extra: Record<string, string> = {}): string => {
  const p = new URLSearchParams({ days: String(q.days), ...extra });
  if (q.scope) p.set('scope', q.scope);
  return p.toString();
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // M84: aquí es donde un error del backend se convierte en un error que alguien VE, así que aquí es
    // donde se cuenta. Es el único punto por el que pasan todas las llamadas del producto: sin esto, el
    // panel de «errores más frecuentes» está estructuralmente vacío y parece que no falla nada.
    //
    // EL CÓDIGO SE DERIVA DEL ESTADO HTTP Y DE NADA MÁS. Ni `detail`, ni el cuerpo, ni el mensaje del
    // `Error` que se lanza abajo pueden entrar en el evento: ese cuerpo es la vía de fuga conocida —el
    // backend devuelve en `message` valores de un grafo y trozos de prompt—, y una vez dentro de la
    // analítica se queda ahí. `http-<status>` ya es un slug por construcción, así que no viaja NI UN
    // carácter de texto libre. Se emite ANTES de leer el cuerpo, para que no haya forma de que el cuerpo
    // llegue a esta llamada ni por descuido de quien edite esto después.
    track('error.displayed', { props: { kind: 'api', code: `http-${res.status}`, httpStatus: res.status } });
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      /* sin cuerpo */
    }
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const headers = { 'content-type': 'application/json' };

/** fetch con el Bearer de la sesión inyectado (para endpoints con scopes RBAC). */
function authHeaders(): Record<string, string> {
  const token = currentToken();
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}

const rawFetch = globalThis.fetch.bind(globalThis);

/**
 * `fetch` del módulo con auth + auto-recuperación (M8): inyecta el Bearer FRESCO en cada intento y,
 * si el backend responde 401 (token caducado a mitad de sesión), re-acuña la sesión de dev y
 * reintenta UNA vez con el token nuevo. Evita que el usuario se quede colgado tras 1h de uso.
 */
async function afetch(input: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), ...authHeaders() } });
  let res = await rawFetch(input, withAuth());
  if (res.status === 401) {
    if (AUTH_MODE === 'dev') {
      // Dev: re-acuña un token del minter y reintenta UNA vez (token caducado a mitad de sesión).
      await ensureDevSession(API);
      res = await rawFetch(input, withAuth());
    } else {
      // Auth real: la sesión ya no vale → límpiala y manda a /login (sin bucle si ya estamos ahí).
      useAuth.getState().clear();
      const path = window.location.pathname;
      if (path !== '/login' && path !== '/register') window.location.assign('/login');
    }
  }
  return res;
}
const fetch = afetch; // el resto del módulo usa el wrapper (auth + retry) en vez del global

export const api = {
  base: API,
  // Toda llamada de negocio lleva el Bearer de la sesión (el backend exige JWT en M8, salvo /health,
  // /auth/token y el ingreso de webhooks). El `authHeaders()` incluye también content-type.
  health: () => fetch(`${API}/health`).then((r) => json<{ status: string; ts: string }>(r)),
  listWorkflows: () => fetch(`${API}/workflows`, { headers: authHeaders() }).then((r) => json<WorkflowDto[]>(r)),
  createWorkflow: (name: string, graph?: WorkflowGraph) =>
    fetch(`${API}/workflows`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name, graph }) }).then((r) =>
      json<WorkflowDto>(r),
    ),
  // «Construir con IA» (M29): descripción en lenguaje natural → grafo generado por la IA. Modelo opcional (M34).
  generateWorkflow: (prompt: string, model?: string) =>
    fetch(`${API}/workflows/generate`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt, model }) }).then((r) =>
      json<{ name: string; graph: WorkflowGraph }>(r),
    ),
  // «Chat con IA en el editor» (M30): instrucción + grafo actual → grafo modificado. Modelo opcional (M34).
  editWorkflowGraph: (graph: WorkflowGraph, prompt: string, model?: string) =>
    fetch(`${API}/workflows/edit`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt, graph, model }) }).then((r) =>
      json<{ name: string; graph: WorkflowGraph }>(r),
    ),
  // «Chat consciente del contexto» (M36): mensaje + grafo actual + contexto (nombre, notas, nodo seleccionado).
  // La IA decide: edita el flujo (kind:'edit') o responde una pregunta sobre él (kind:'answer').
  chatWorkflow: (
    graph: WorkflowGraph,
    message: string,
    ctx: { name?: string; notes?: string[]; selected?: string; model?: string; page?: string } = {},
  ) =>
    fetch(`${API}/workflows/chat`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message, graph, ...ctx }) }).then((r) =>
      json<{ kind: 'edit'; name: string; graph: WorkflowGraph } | { kind: 'answer'; text: string }>(r),
    ),
  getWorkflow: (id: string) => fetch(`${API}/workflows/${id}`, { headers: authHeaders() }).then((r) => json<WorkflowDto>(r)),
  deleteWorkflow: (id: string) =>
    fetch(`${API}/workflows/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ deleted: boolean }>(r)),
  saveGraph: (id: string, graph: WorkflowGraph) =>
    fetch(`${API}/workflows/${id}/graph`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(graph) }).then((r) =>
      json<WorkflowDto>(r),
    ),
  publish: (id: string) =>
    fetch(`${API}/workflows/${id}/publish`, { method: 'POST', headers: authHeaders() }).then((r) =>
      json<{ id: string; version: number; state: string }>(r),
    ),
  listVersions: (id: string) =>
    fetch(`${API}/workflows/${id}/versions`, { headers: authHeaders() }).then((r) =>
      json<Array<{ id: string; version: number; state: string; publishedAt: string | null }>>(r),
    ),

  // --- Compartir por enlace (M85): un workflow sanitizado viaja como plantilla portable ---
  // `dryRun` (por defecto) solo devuelve el informe de qué viajaría; sin él crea el enlace.
  createShare: (id: string, body: CreateShareRequest) =>
    fetch(`${API}/workflows/${id}/share`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }).then((r) =>
      json<CreateShareResponse>(r),
    ),
  // Lectura PÚBLICA del enlace (invitado sin sesión): rawFetch, sin Bearer ni recuperación 401 (como getInvite).
  getShare: (token: string) => rawFetch(`${API}/shares/${token}`, { headers }).then((r) => json<SharePreviewResponse>(r)),
  // Importar a la cuenta del usuario autenticado: crea agentes + workflow y cuenta la instalación.
  importShare: (token: string) =>
    fetch(`${API}/shares/${token}/import`, { method: 'POST', headers: authHeaders() }).then((r) => json<{ imported: true }>(r)),
  // Revocar un enlace creado (deja de resolver para quien lo tenga).
  revokeShare: (token: string) =>
    fetch(`${API}/shares/${token}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ revoked: true }>(r)),
  /**
   * M84: aquí se marca el ARRANQUE de una ejecución manual. Es el evento que no se puede rellenar hacia
   * atrás, así que se emite pase lo que pase.
   *
   * OJO con el desenlace: este POST solo ENCOLA (devuelve QUEUED/RUNNING, nunca un estado terminal), así
   * que un `succeeded` aquí contaría como buena toda ejecución aceptada y la tasa de fallo saldría
   * siempre a cero. Por eso aquí solo se emite `failed` cuando la ejecución ni siquiera llega a arrancar;
   * el desenlace real lo emite el editor cuando el stream llega a SUCCEEDED/FAILED.
   */
  execute: async (workflowId: string, context?: Record<string, unknown>) => {
    track('workflow.run.started', { entityType: 'workflow', entityId: workflowId, props: { trigger: 'manual' } });
    try {
      return await fetch(`${API}/executions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ workflowId, context }),
      }).then((r) => json<{ executionId: string; status: string }>(r));
    } catch (e) {
      track('workflow.run.failed', { entityType: 'workflow', entityId: workflowId });
      throw e;
    }
  },
  getExecution: (id: string) => fetch(`${API}/executions/${id}`, { headers: authHeaders() }).then((r) => json<ExecutionDetailDto>(r)),
  // --- Claves de API / MCP (M32): conectar Claude Desktop/ChatGPT/Cursor ---
  listApiKeys: () => fetch(`${API}/api-keys`, { headers: authHeaders() }).then((r) => json<ApiKeyView[]>(r)),
  createApiKey: (label: string) =>
    fetch(`${API}/api-keys`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ label }) }).then((r) =>
      json<{ id: string; rawKey: string; view: ApiKeyView }>(r),
    ),
  revokeApiKey: (id: string) =>
    fetch(`${API}/api-keys/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ revoked: boolean }>(r)),
  // --- Claves de IA propias del workspace (BYOK, M35) ---
  listLlmKeys: () => fetch(`${API}/llm-keys`, { headers: authHeaders() }).then((r) => json<LlmKeyView[]>(r)),
  setLlmKey: (provider: string, apiKey: string) =>
    fetch(`${API}/llm-keys`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ provider, apiKey }) }).then((r) =>
      json<{ provider: string; last4: string }>(r),
    ),
  removeLlmKey: (provider: string) =>
    fetch(`${API}/llm-keys/${provider}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ removed: boolean }>(r)),
  /** Delta del stream (M9): solo los eventos con `seq > since`, para el poll incremental de la consola. */
  getExecutionEvents: (id: string, since: number) =>
    fetch(`${API}/executions/${id}/events?since=${since}`, { headers: authHeaders() }).then((r) => json<{ events: ExecutionEvent[] }>(r)),
  /** Artefacto de una ejecución (M72): captura/PDF que guardó una tool; llega como data URL listo para `<img src>`. */
  getExecutionFile: (id: string, fileId: string) =>
    fetch(`${API}/executions/${id}/files/${fileId}`, { headers: authHeaders() }).then((r) =>
      json<{ name: string; mimeType: string; dataUrl: string }>(r),
    ),

  // --- Webhooks / triggers entrantes (M7) ---
  listWebhooks: (workflowId: string) =>
    fetch(`${API}/workflows/${workflowId}/webhooks`, { headers: authHeaders() }).then((r) =>
      json<Array<{ id: string; url: string; event: string; active: boolean }>>(r),
    ),
  createWebhook: (workflowId: string, event = 'webhook') =>
    fetch(`${API}/workflows/${workflowId}/webhooks`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ event }) }).then((r) =>
      json<{ id: string; url: string; event: string; signingSecret: string }>(r),
    ),
  deleteWebhook: (id: string) => fetch(`${API}/webhooks/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<unknown>(r)),

  // --- Triggers programados (cron/intervalo, M7-B) ---
  listSchedules: (workflowId: string) =>
    fetch(`${API}/workflows/${workflowId}/schedules`, { headers: authHeaders() }).then((r) =>
      json<Array<{ id: string; cron: string | null; everyMs: number | null; active: boolean; poll?: { provider: string; connectorId: string; folderId?: string; projectId?: string } | null }>>(r),
    ),
  createSchedule: (
    workflowId: string,
    // M52: `poll` convierte el schedule en un SONDEO (Google Drive: nuevo fichero; Sentry: nuevo issue, M79).
    spec: { cron?: string; everyMs?: number; poll?: { provider: string; connectorId: string; folderId?: string; projectId?: string } },
  ) =>
    fetch(`${API}/workflows/${workflowId}/schedules`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(spec) }).then((r) =>
      json<{ id: string; cron: string | null; everyMs: number | null; active: boolean }>(r),
    ),
  deleteSchedule: (id: string) => fetch(`${API}/schedules/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<unknown>(r)),

  // --- Conectores (OAuth + dispatch saliente, M11) ---
  listConnectorProviders: () =>
    fetch(`${API}/connectors/providers`, { headers: authHeaders() }).then((r) =>
      json<Array<{ provider: string; label: string; scopes: string[]; requiresConfig: boolean; configured: boolean; configProvider: string; pkce?: boolean }>>(r),
    ),
  listConnectors: () =>
    fetch(`${API}/connectors`, { headers: authHeaders() }).then((r) =>
      json<Array<{ id: string; key: string; provider: string; status: 'connected' | 'disconnected'; credentialsSecretId: string | null }>>(r),
    ),
  createConnector: (provider: string, key: string) =>
    fetch(`${API}/connectors`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ provider, key }) }).then((r) =>
      json<{ id: string; key: string; provider: string; status: string }>(r),
    ),
  connectConnector: (id: string) =>
    fetch(`${API}/connectors/${id}/connect`, { method: 'POST', headers: authHeaders() }).then((r) => json<{ authorizeUrl: string }>(r)),
  deleteConnector: (id: string) => fetch(`${API}/connectors/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<unknown>(r)),
  /** Carpetas del Google Drive del conector (M54): pobla el desplegable «Carpeta de Drive» del trigger. */
  driveFolders: (connectorId: string) =>
    fetch(`${API}/connectors/${connectorId}/drive-folders`, { headers: authHeaders() }).then((r) => json<{ folders: Array<{ id: string; name: string }> }>(r)),
  /** Canales del Slack del conector (M57): pobla el desplegable «Canal» del nodo conector. */
  slackChannels: (connectorId: string) =>
    fetch(`${API}/connectors/${connectorId}/slack-channels`, { headers: authHeaders() }).then((r) => json<{ channels: Array<{ id: string; name: string }> }>(r)),
  /** Proyectos del Sentry del conector (M79): pobla el desplegable «Proyecto» del trigger y de las acciones. */
  sentryProjects: (connectorId: string) =>
    fetch(`${API}/connectors/${connectorId}/sentry-projects`, { headers: authHeaders() }).then((r) => json<{ projects: Array<{ id: string; name: string }> }>(r)),
  /** Repositorios del GitHub del conector: pobla el desplegable «Repositorio» de las acciones. */
  githubRepos: (connectorId: string) =>
    fetch(`${API}/connectors/${connectorId}/github-repos`, { headers: authHeaders() }).then((r) => json<{ repos: Array<{ id: string; name: string }> }>(r)),

  // --- Triggers sin código (recetas + auto-registro en el proveedor, M19) ---
  /** Proyectos de Jira accesibles con un conector (para el desplegable del picker). */
  jiraProjects: (connectorId: string, cloudId?: string) =>
    fetch(`${API}/connectors/${connectorId}/jira-projects${cloudId ? `?cloudId=${encodeURIComponent(cloudId)}` : ''}`, { headers: authHeaders() }).then((r) =>
      json<{ cloudId: string; projects: Array<{ key: string; name: string }> }>(r),
    ),
  listTriggerBindings: (workflowId: string) =>
    fetch(`${API}/workflows/${workflowId}/triggers`, { headers: authHeaders() }).then((r) => json<TriggerBindingDto[]>(r)),
  createTriggerBinding: (workflowId: string, body: { eventId: string; connectorId: string; params?: Record<string, unknown> }) =>
    fetch(`${API}/workflows/${workflowId}/triggers`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }).then((r) =>
      json<TriggerBindingDto>(r),
    ),
  deleteTriggerBinding: (id: string) =>
    fetch(`${API}/triggers/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<unknown>(r)),

  listExecutions: (status?: string, workflowId?: string) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (workflowId) qs.set('workflowId', workflowId);
    const q = qs.toString();
    return fetch(`${API}/executions${q ? `?${q}` : ''}`, { headers: authHeaders() }).then((r) =>
      json<{ workspaceId: string; executions: ExecutionRow[] }>(r),
    );
  },
  listAgents: () => fetch(`${API}/agents`, { headers: authHeaders() }).then((r) => json<AgentDto[]>(r)),
  createAgent: (body: AgentInput) =>
    fetch(`${API}/agents`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }).then((r) => json<AgentDto>(r)),
  // «Crear asistente con IA» (M68): la persona lo describe; la IA devuelve un borrador para rellenar el
  // formulario (kind:'create') o una respuesta si solo pregunta (kind:'answer').
  chatAgent: (message: string, ctx: { model?: string } = {}) =>
    fetch(`${API}/agents/chat`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message, ...ctx }) }).then((r) =>
      json<{ kind: 'create'; agent: AgentDraft } | { kind: 'answer'; text: string }>(r),
    ),
  // Verifica un servidor MCP (M43/M45): prueba la conexión (con su credencial si está conectado) y avisa si
  // faltan credenciales o no responde.
  verifyMcp: (url: string, serverId?: string) =>
    fetch(`${API}/agents/mcp/verify`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ url, serverId }) }).then((r) =>
      json<{ ok: boolean; tools?: number; needsAuth?: boolean; connected?: boolean; reason?: string }>(r),
    ),
  // «Conectar» un servidor MCP (M45): guarda su credencial cifrada para activarlo.
  connectMcp: (serverId: string, token: string) =>
    fetch(`${API}/agents/mcp/connect`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ serverId, token }) }).then((r) =>
      json<{ connected: boolean }>(r),
    ),
  disconnectMcp: (serverId: string) =>
    fetch(`${API}/agents/mcp/connect/${serverId}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ connected: boolean }>(r)),
  updateAgent: (id: string, body: Partial<AgentInput>) =>
    fetch(`${API}/agents/${id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify(body) }).then((r) => json<AgentDto>(r)),
  deleteAgent: (id: string) =>
    fetch(`${API}/agents/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ deleted: boolean }>(r)),

  // --- Autenticación real: email+contraseña (M73). login/register son públicos → usan rawFetch (sin el
  // wrapper de recuperación 401, que aquí solo daría un bucle). Devuelven la sesión: token + perfil. ---
  register: (input: { name: string; email: string; password: string }) =>
    rawFetch(`${API}/auth/register`, { method: 'POST', headers, body: JSON.stringify(input) }).then((r) =>
      json<{ accessToken: string; user: SessionUser }>(r),
    ),
  login: (input: { email: string; password: string }) =>
    rawFetch(`${API}/auth/login`, { method: 'POST', headers, body: JSON.stringify(input) }).then((r) =>
      json<{ accessToken: string; user: SessionUser }>(r),
    ),
  me: () => fetch(`${API}/auth/me`, { headers: authHeaders() }).then((r) => json<{ sub: string; email: string; role: Role; workspaceId: string }>(r)),

  // --- Equipo (M74): miembros e invitaciones ---
  getTeam: () => fetch(`${API}/team/members`, { headers: authHeaders() }).then((r) => json<TeamDataDto>(r)),
  inviteMember: (input: { email: string; role: Role }) =>
    fetch(`${API}/team/invitations`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(input) }).then((r) =>
      json<{ invitation: TeamInvitationDto; acceptUrl: string; emailSent: boolean }>(r),
    ),
  revokeInvite: (id: string) =>
    fetch(`${API}/team/invitations/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<{ revoked: boolean }>(r)),
  updateMember: (userId: string, patch: { role?: Role; disabled?: boolean }) =>
    fetch(`${API}/team/members/${userId}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify(patch) }).then((r) => json<TeamMemberDto>(r)),
  // Públicos (invitado sin sesión): rawFetch, sin recuperación 401.
  getInvite: (token: string) =>
    rawFetch(`${API}/team/invite/${token}`, { headers }).then((r) => json<{ email: string; role: Role }>(r)),
  acceptInvite: (token: string, input: { name: string; password: string }) =>
    rawFetch(`${API}/team/invite/${token}/accept`, { method: 'POST', headers, body: JSON.stringify(input) }).then((r) =>
      json<{ accessToken: string; user: SessionUser }>(r),
    ),

  // --- Analítica de producto (M84): panel interno. Exige `analytics:read` (OWNER/ADMIN) y, para
  // `scope: 'all'`, además ser administrador de plataforma. Las dos cosas las decide el servidor. ---
  /** Qué puede ver quien pregunta. El nav se apoya en esto para no enseñar una puerta que no abre. */
  insightsMe: () => fetch(`${API}/insights/me`, { headers: authHeaders() }).then((r) => json<{ platformAdmin: boolean; collecting: boolean }>(r)),
  insightsOverview: (q: InsightsQuery) =>
    fetch(`${API}/insights/overview?${insightsQs(q)}`, { headers: authHeaders() }).then((r) => json<InsightsOverviewDto>(r)),
  /** Lo más tocado de un tipo. `name`/`entityType` van tipados: el servidor solo acepta los del catálogo. */
  insightsEntities: (q: InsightsQuery & { name: EventName; entityType: EntityType }) =>
    fetch(`${API}/insights/entities?${insightsQs(q, { name: q.name, entityType: q.entityType })}`, { headers: authHeaders() }).then((r) =>
      json<EntityRow[]>(r),
    ),
  /** Uso por función CRUZADO CONTRA EL INVENTARIO: incluye los ceros, que es de lo que va el informe. */
  insightsFeatures: (q: InsightsQuery) =>
    fetch(`${API}/insights/features?${insightsQs(q)}`, { headers: authHeaders() }).then((r) => json<FeatureUsageRow[]>(r)),
  insightsRetention: (q: InsightsQuery & { cohortDays: number }) =>
    fetch(`${API}/insights/retention?${insightsQs(q, { cohortDays: String(q.cohortDays) })}`, { headers: authHeaders() }).then((r) =>
      json<RetentionRow[]>(r),
    ),
  insightsSearch: (q: InsightsQuery) =>
    fetch(`${API}/insights/search?${insightsQs(q)}`, { headers: authHeaders() }).then((r) => json<SearchRow[]>(r)),
  insightsFunnel: (q: InsightsQuery & { steps: EventName[]; windowMinutes: number }) =>
    fetch(`${API}/insights/funnel?${insightsQs(q, { steps: q.steps.join(','), windowMinutes: String(q.windowMinutes) })}`, {
      headers: authHeaders(),
    }).then((r) => json<FunnelRow[]>(r)),

  // --- Escalado humano (M5-B) ---
  devToken: (role: Role, sub = `dev_${role.toLowerCase()}`) =>
    fetch(`${API}/auth/token`, { method: 'POST', headers, body: JSON.stringify({ role, sub }) }).then((r) =>
      json<{ accessToken: string }>(r),
    ),
  getReviews: (executionId: string) =>
    fetch(`${API}/executions/${executionId}/reviews`, { headers: authHeaders() }).then((r) => json<ReviewDto[]>(r)),
  resolveReview: (executionId: string, body: { approved: boolean; decision?: string; reviewId?: string }) =>
    fetch(`${API}/executions/${executionId}/human`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    }).then((r) => json<{ review: ReviewDto; alreadyResolved: boolean }>(r)),
};
