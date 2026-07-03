import type { IAgentRepository, IMemoryStore, IPendingReviewRepository, IConnectorRepository, ISecretStore } from '@core/engine';
import type { ModelRouter } from '@core/llm';
import { NodeExecutorRegistry } from './registry';
import { createDefaultNodeRegistry, WorkNodeExecutor, WaitNodeExecutor } from './executors';
import { ConditionNodeExecutor, HttpNodeExecutor } from './executors-io';
import { ToolRegistry, MockTool, HttpTool } from './tools';
import { ToolAuthorizationService } from './tool-authorization';
import { AgentRuntime } from './agent-runtime';
import { LlmPlanner } from './planner';
import { Orchestrator } from './orchestrator';
import { AgentNodeExecutor } from './agent-node';
import { HumanNodeExecutor } from './human-node';
import { ConnectorNodeExecutor } from './connector-node';

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
  registry.register(new WaitNodeExecutor());
  registry.register(new WorkNodeExecutor('tool', deps.stepDelayMs ?? 0));

  const runtime = new AgentRuntime({
    router: deps.llmRouter,
    tools: new ToolRegistry().register(new MockTool()).register(new HttpTool(deps.httpAllowlist ?? [])),
    authz: new ToolAuthorizationService(),
    memory: deps.memory,
  });
  const orchestrator = new Orchestrator({
    planner: new LlmPlanner(deps.llmRouter, deps.plannerModel ?? 'mock-1'),
    agents: deps.agents,
    runtime,
  });
  registry.register(new AgentNodeExecutor(runtime, deps.agents, 'agent', orchestrator));
  registry.register(new AgentNodeExecutor(runtime, deps.agents, 'llm'));
  if (deps.pendingReviews) registry.register(new HumanNodeExecutor(deps.pendingReviews));
  if (deps.connectors && deps.secrets) {
    registry.register(new ConnectorNodeExecutor(deps.connectors, deps.secrets, deps.selfBase));
  }
  return registry;
}
