import type { IAgentRepository, IMemoryStore, IPendingReviewRepository, IConnectorRepository, ISecretStore } from '@core/engine';
import { createRuntimeRegistry, type NodeExecutorRegistry } from '@core/sdk-plugins';
import { createLlmRouter } from '@core/llm';

export const NODE_REGISTRY = Symbol('NODE_REGISTRY');

const stepDelay = Number(process.env.EXEC_STEP_DELAY_MS ?? 250);
const HTTP_ALLOWLIST = (process.env.TOOL_HTTP_ALLOWLIST ?? 'example.com,httpbin.org').split(',').map((s) => s.trim());
/** URL de la propia API (donde vive el proveedor `dev`), para el baseUrl del nodo de conector. */
const SELF_BASE = process.env.API_SELF_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;

/** Registro de nodos de la API (ejecución inline) — misma maquinaria que el worker durable. */
export function buildNodeRegistry(deps: {
  agents: IAgentRepository;
  memory?: IMemoryStore;
  pendingReviews?: IPendingReviewRepository;
  connectors?: IConnectorRepository;
  secrets?: ISecretStore;
}): NodeExecutorRegistry {
  return createRuntimeRegistry({
    agents: deps.agents,
    memory: deps.memory,
    pendingReviews: deps.pendingReviews,
    connectors: deps.connectors,
    secrets: deps.secrets,
    selfBase: SELF_BASE,
    llmRouter: createLlmRouter(),
    httpAllowlist: HTTP_ALLOWLIST,
    stepDelayMs: stepDelay,
  });
}
