import type { IAgentRepository, IMemoryStore, IPendingReviewRepository, IConnectorRepository, ISecretStore, IMcpToolResolver, IFileStore } from '@core/engine';
import type { ModelRouter } from '@core/llm';
import { NodeExecutorRegistry } from './registry';
import { createDefaultNodeRegistry, WorkNodeExecutor, WaitNodeExecutor } from './executors';
import { ConditionNodeExecutor, HttpNodeExecutor } from './executors-io';
import { CodeNodeExecutor } from './code-node';
import { DownloadFileNodeExecutor } from './download-node';
import { ExtractTextNodeExecutor } from './extract-node';
import { ToolRegistry, MockTool, HttpTool } from './tools';
import { BrowserTool } from './browser-tool';
import { ToolAuthorizationService } from './tool-authorization';
import { AgentRuntime } from './agent-runtime';
import { LlmPlanner } from './planner';
import { Orchestrator } from './orchestrator';
import { AgentNodeExecutor } from './agent-node';
import { HumanNodeExecutor } from './human-node';
import { ConnectorNodeExecutor } from './connector-node';
import { RouterNodeExecutor } from './router-node';
import { IntegrationToolResolver, composeMcpResolvers } from './integration-tool-resolver';

export interface RuntimeRegistryDeps {
  agents: IAgentRepository;
  llmRouter: ModelRouter;
  memory?: IMemoryStore;
  /** Si se provee, se registra el nodo Humano (escalado M5). Sin él no hay human-in-the-loop. */
  pendingReviews?: IPendingReviewRepository;
  /** Si se proveen ambos, se registra el nodo de Conector (dispatch saliente autenticado, M11). */
  connectors?: IConnectorRepository;
  secrets?: ISecretStore;
  /** URL de la propia API (donde vive el proveedor `dev`), para resolver el baseUrl del conector. */
  selfBase?: string;
  httpAllowlist?: string[];
  /** M40: resuelve los servidores MCP de un agente en herramientas invocables. Sin él, no hay tools MCP. */
  mcp?: IMcpToolResolver;
  /** M48: almacén de ficheros para el nodo «Descargar fichero». Sin él, ese nodo devuelve error. */
  files?: IFileStore;
  stepDelayMs?: number;
  plannerModel?: string;
}

/**
 * Construye el registro de nodos COMPLETO (control + condición/http/wait/tool + agente/llm +
 * orchestrator). Compartido por la API (ejecución inline) y el worker (despacho durable BullMQ),
 * para que ambos ejecuten exactamente la misma maquinaria.
 */
export function createRuntimeRegistry(deps: RuntimeRegistryDeps): NodeExecutorRegistry {
  const registry = createDefaultNodeRegistry(); // trigger + end
  registry.register(new ConditionNodeExecutor());
  registry.register(new HttpNodeExecutor());
  registry.register(new CodeNodeExecutor()); // M46: nodo «Transformar datos» (JS en worker aislado)
  registry.register(new DownloadFileNodeExecutor(deps.files)); // M48: nodo «Descargar fichero»
  registry.register(new ExtractTextNodeExecutor(deps.files)); // M49: nodo «Extraer texto» (PDF/CSV/texto)
  registry.register(new WaitNodeExecutor());
  registry.register(new WorkNodeExecutor('tool', deps.stepDelayMs ?? 0));

  // M76: integraciones de primera clase (Atlassian…). Si hay conectores+secretos, resuelve las refs
  // `integration://<key>` del agente a herramientas con el token OAuth (dueña la plataforma) inyectado.
  // Se COMPONE con el resolver MCP HTTP: cada uno ignora las refs del otro.
  const integrationResolver =
    deps.connectors && deps.secrets ? new IntegrationToolResolver(deps.connectors, deps.secrets) : undefined;

  const runtime = new AgentRuntime({
    router: deps.llmRouter,
    tools: new ToolRegistry()
      .register(new MockTool())
      .register(new HttpTool(deps.httpAllowlist ?? []))
      .register(new BrowserTool({ files: deps.files })), // M71/M72: «Browser Automation» — motor intercambiable + capturas persistidas (replay)
    authz: new ToolAuthorizationService(),
    memory: deps.memory,
    mcp: composeMcpResolvers(deps.mcp, integrationResolver),
  });
  const orchestrator = new Orchestrator({
    planner: new LlmPlanner(deps.llmRouter, deps.plannerModel ?? 'mock-1'),
    agents: deps.agents,
    runtime,
  });
  registry.register(new AgentNodeExecutor(runtime, deps.agents, 'agent', orchestrator, deps.memory));
  // M82: `deps.memory` habilita «no repetir lo que ya envió» en el paso de IA (un boletín diario que, si no,
  // volvería a elegir lo mismo cada día porque cada ejecución arranca en blanco).
  registry.register(new AgentNodeExecutor(runtime, deps.agents, 'llm', undefined, deps.memory));
  // Router (M14): el coordinador enruta a los nodos de agente conectados (usa el LLM para elegir).
  registry.register(new RouterNodeExecutor(deps.agents, deps.llmRouter));
  if (deps.pendingReviews) registry.register(new HumanNodeExecutor(deps.pendingReviews));
  if (deps.connectors && deps.secrets) {
    registry.register(new ConnectorNodeExecutor(deps.connectors, deps.secrets, deps.selfBase));
  }
  return registry;
}
