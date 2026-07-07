import { z } from 'zod';
import type { Role } from '@core/contracts';
import type { WorkflowsService } from '../workflows/workflows.service';
import type { AgentsService } from '../agents/agents.service';
import type { ExecutionsService } from '../execution/executions.service';
import type { ConnectorsService } from '../connectors/connectors.service';
import type { RbacService } from '../rbac/rbac.service';
import type { ApiKeyPrincipal } from '../api-keys/api-key.util';
import type { McpServerLike, McpToolResult } from './mcp-sdk';

/** Servicios + principal que reciben los handlers de las tools (todo acotado al workspace del principal). */
export interface McpContext {
  principal: ApiKeyPrincipal;
  workflows: WorkflowsService;
  agents: AgentsService;
  executions: ExecutionsService;
  connectors: ConnectorsService;
  rbac: RbacService;
}

/** Catálogo estructurado de tipos de nodo (lo que un modelo necesita para construir un grafo válido). */
export const NODE_TYPE_CATALOG = [
  { type: 'trigger', purpose: 'Inicio del flujo. SIEMPRE el primer nodo.', config: { event: '"manual" | "webhook" | "cron"' } },
  { type: 'llm', purpose: 'Redactar/resumir/clasificar con la IA integrada.', config: { model: 'string', prompt: 'string', input: 'string (admite {{variables}})' } },
  { type: 'api', purpose: 'Llamar por HTTP a cualquier API externa (NewsAPI, OpenAI, Telegram…).', config: { method: 'string', url: 'string', headers: 'JSON string', body: 'JSON string' } },
  { type: 'connector', purpose: 'Enviar a una app conectada (Slack, Jira, GitHub, Google…).', config: { connectorId: 'string', method: 'string', path: 'string', body: 'JSON string' } },
  { type: 'agent', purpose: 'Delegar en un agente por id (un orquestador planifica y reparte).', config: { agentId: 'string', input: 'string' } },
  { type: 'condition', purpose: 'Bifurcar; sus aristas de salida usan sourceHandle "true"/"false".', config: { expression: 'string' } },
  { type: 'router', purpose: 'Repartir dinámicamente entre agentes según el contexto.', config: {} },
  { type: 'human', purpose: 'Pausar para aprobación humana.', config: { reason: 'string' } },
  { type: 'tool', purpose: 'Anotar/registrar un mensaje.', config: { message: 'string' } },
  { type: 'wait', purpose: 'Esperar N ms.', config: { ms: 'number' } },
  { type: 'end', purpose: 'Nodo final. SIEMPRE al menos uno.', config: {} },
] as const;

const graphShape = z.object({ nodes: z.array(z.record(z.unknown())), edges: z.array(z.record(z.unknown())) });

function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function fail(message: string): McpToolResult {
  // Nunca relanzamos: el error va como isError para que el cliente lo vea como resultado, no como fallo de protocolo.
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Ejecuta el handler afirmando el scope RBAC (el MCP no pasa por ScopesGuard) y capturando errores. */
async function run(role: Role, rbac: RbacService, scope: string | null, fn: () => Promise<unknown> | unknown): Promise<McpToolResult> {
  try {
    if (scope) rbac.assert(role, scope);
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Registra TODAS las tools base del MCP (M32). Cada handler llama a un servicio existente con
 * `ctx.principal.workspaceId` (aislamiento por tenant) y re-afirma el scope RBAC del rol de la clave.
 */
export function registerTools(server: McpServerLike, ctx: McpContext): void {
  const ws = ctx.principal.workspaceId;
  const role = ctx.principal.role;
  const r = ctx.rbac;

  server.registerTool('whoami', { title: 'Quién soy', description: 'Devuelve el principal (workspace, rol, email) de esta conexión.' },
    async () => ok(ctx.principal));

  server.registerTool('list_node_types', { title: 'Tipos de nodo', description: 'Catálogo de tipos de nodo y su config, para construir grafos válidos.' },
    async () => ok(NODE_TYPE_CATALOG));

  // ---- Workflows ----
  server.registerTool('list_workflows', { title: 'Listar automatizaciones', description: 'Lista las automatizaciones (workflows) del workspace.' },
    async () => run(role, r, 'workflow:read', () => ctx.workflows.list(ws)));

  server.registerTool('get_workflow', { title: 'Ver automatización', description: 'Devuelve una automatización con su grafo.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'workflow:read', () => ctx.workflows.get(id, ws)));

  server.registerTool('create_workflow', { title: 'Crear automatización', description: 'Crea una automatización, opcionalmente con un grafo inicial.', inputSchema: { name: z.string(), graph: graphShape.optional() } },
    async ({ name, graph }) => run(role, r, 'workflow:write', () => ctx.workflows.create({ name, graph }, ws)));

  server.registerTool('update_workflow_graph', { title: 'Actualizar grafo', description: 'Reemplaza el grafo (nodos+aristas) de una automatización. Valida que sea un DAG.', inputSchema: { id: z.string(), graph: graphShape } },
    async ({ id, graph }) => run(role, r, 'workflow:write', () => ctx.workflows.saveGraph(id, graph, ws)));

  server.registerTool('publish_workflow', { title: 'Publicar', description: 'Congela el borrador en una versión publicada inmutable.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'workflow:write', () => ctx.workflows.publish(id, ws)));

  server.registerTool('delete_workflow', { title: 'Borrar automatización', description: 'Borra una automatización con todo su historial. Irreversible.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'workflow:delete', () => ctx.workflows.remove(id, ws)));

  server.registerTool('generate_workflow', { title: 'Generar con IA', description: 'Describe la automatización y la IA la monta y la CREA en el workspace. Opcional: elige el modelo.', inputSchema: { prompt: z.string(), model: z.string().optional() } },
    async ({ prompt, model }) => run(role, r, 'workflow:write', async () => {
      const { name, graph } = await ctx.workflows.generate(prompt, ws, model);
      return ctx.workflows.create({ name, graph }, ws);
    }));

  server.registerTool('edit_workflow', { title: 'Editar con IA', description: 'Modifica una automatización existente en lenguaje natural y guarda el resultado. Opcional: elige el modelo.', inputSchema: { id: z.string(), prompt: z.string(), model: z.string().optional() } },
    async ({ id, prompt, model }) => run(role, r, 'workflow:write', async () => {
      const wf = (await ctx.workflows.get(id, ws)) as { graph?: unknown };
      const { graph } = await ctx.workflows.editGraph(wf.graph, prompt, ws, model);
      return ctx.workflows.saveGraph(id, graph, ws);
    }));

  // ---- Ejecución ----
  server.registerTool('run_workflow', { title: 'Ejecutar', description: 'Lanza una ejecución de una automatización. Devuelve el executionId y el estado.', inputSchema: { workflowId: z.string(), context: z.record(z.unknown()).optional() } },
    async ({ workflowId, context }) => run(role, r, 'execution:create', () => ctx.executions.start(workflowId, ws, context, 'manual')));

  server.registerTool('list_executions', { title: 'Listar ejecuciones', description: 'Lista ejecuciones recientes del workspace (opcional: filtrar por estado).', inputSchema: { status: z.string().optional(), limit: z.number().int().positive().optional() } },
    async ({ status, limit }) => run(role, r, 'execution:read', () => ctx.executions.list(ws, { status, limit })));

  server.registerTool('get_execution', { title: 'Ver ejecución', description: 'Devuelve el estado y los eventos de una ejecución.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'execution:read', () => ctx.executions.get(id, ws)));

  // ---- Agentes ----
  server.registerTool('list_agents', { title: 'Listar agentes', description: 'Lista los agentes del workspace.' },
    async () => run(role, r, 'agent:read', () => ctx.agents.list(ws)));

  server.registerTool('create_agent', { title: 'Crear agente', description: 'Crea un agente. isOrchestrator=true lo hace coordinador de otros agentes.', inputSchema: { name: z.string(), systemPrompt: z.string().optional(), model: z.string().optional(), description: z.string().optional(), tools: z.array(z.string()).optional(), isOrchestrator: z.boolean().optional() } },
    async (body) => run(role, r, 'agent:write', () => ctx.agents.create(body, ws)));

  server.registerTool('update_agent', { title: 'Actualizar agente', description: 'Actualiza los campos indicados de un agente.', inputSchema: { id: z.string(), name: z.string().optional(), systemPrompt: z.string().optional(), model: z.string().optional(), description: z.string().optional(), tools: z.array(z.string()).optional(), isOrchestrator: z.boolean().optional() } },
    async ({ id, ...patch }) => run(role, r, 'agent:write', () => ctx.agents.update(id, patch, ws)));

  server.registerTool('delete_agent', { title: 'Borrar agente', description: 'Borra un agente del workspace.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'agent:write', () => ctx.agents.remove(id, ws)));

  // ---- Conectores ----
  server.registerTool('list_connectors', { title: 'Listar conectores', description: 'Lista las integraciones conectadas (Slack, Jira, GitHub, Google…).' },
    async () => run(role, r, 'connector:read', () => ctx.connectors.list(ws)));
}
