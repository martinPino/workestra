import type { WorkflowGraph, ExecutionEvent } from '@core/contracts';
import { currentToken, ensureDevSession, type Role } from './auth';

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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
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
    await ensureDevSession(API);
    res = await rawFetch(input, withAuth());
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
  execute: (workflowId: string, context?: Record<string, unknown>) =>
    fetch(`${API}/executions`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ workflowId, context }) }).then((r) =>
      json<{ executionId: string; status: string }>(r),
    ),
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
      json<Array<{ id: string; cron: string | null; everyMs: number | null; active: boolean; poll?: { provider: string; connectorId: string; folderId?: string } | null }>>(r),
    ),
  createSchedule: (
    workflowId: string,
    // M52: `poll` convierte el schedule en un SONDEO (p. ej. Google Drive: nuevo fichero).
    spec: { cron?: string; everyMs?: number; poll?: { provider: string; connectorId: string; folderId?: string } },
  ) =>
    fetch(`${API}/workflows/${workflowId}/schedules`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(spec) }).then((r) =>
      json<{ id: string; cron: string | null; everyMs: number | null; active: boolean }>(r),
    ),
  deleteSchedule: (id: string) => fetch(`${API}/schedules/${id}`, { method: 'DELETE', headers: authHeaders() }).then((r) => json<unknown>(r)),

  // --- Conectores (OAuth + dispatch saliente, M11) ---
  listConnectorProviders: () =>
    fetch(`${API}/connectors/providers`, { headers: authHeaders() }).then((r) =>
      json<Array<{ provider: string; label: string; scopes: string[]; requiresConfig: boolean; configured: boolean; configProvider: string }>>(r),
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
