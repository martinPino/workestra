import { AgentsService } from '../agents/agents.service';
import { LlmKeysService } from '../llm-keys/llm-keys.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ExecutionsService } from '../execution/executions.service';
import { ExecutionEventHub } from '../execution/execution-event-hub';
import { HumanEscalationService } from '../execution/human-escalation.service';
import { TriggersService } from '../triggers/triggers.service';
import { SchedulesService } from '../schedules/schedules.service';
import { buildNodeRegistry } from '../execution/node-registry';
import { AuthService } from '../auth/auth.service';
import { WebCryptoTokenSigner } from '../auth/token-signer';
import { TeamService } from '../team/team.service';
import { ApiKeyAuthService } from '../api-keys/api-key-auth.service';
import { SharesService } from '../shares/shares.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { WorkflowsDispatcher, type ExecutionDispatcher } from '../execution/dispatcher';
import type { PersistenceBundle } from '../persistence/bundle';

/**
 * Construcción de servicios a mano: el reemplazo del contenedor DI de Nest.
 *
 * Los servicios ya recibían todo por constructor, así que el contenedor solo aportaba el cableado
 * automático. Aquí se escribe explícito, que en un grafo de esta forma —poco profundo y sin ciclos— es
 * además más fácil de seguir que un árbol de módulos.
 *
 * Y arregla el gotcha que `CLAUDE.md` documenta: «`pnpm verify` no levanta el contenedor DI, así que un
 * guard cuyo módulo no está registrado pasa verify y crash-loopea en Railway». Sin contenedor no existe
 * esa clase de fallo: si falta una dependencia, no compila.
 */
export interface Services {
  agents: AgentsService;
  llmKeys: LlmKeysService;
  workflows: WorkflowsService;
  executions: ExecutionsService;
  humanEscalation: HumanEscalationService;
  triggers: TriggersService;
  schedules: SchedulesService;
  hub: ExecutionEventHub;
  auth: AuthService;
  team: TeamService;
  apiKeys: ApiKeyAuthService;
  shares: SharesService;
  webhooks: WebhooksService;
  connectors: ConnectorsService;
}

export function buildServices(p: PersistenceBundle, jwtSecret: string, dispatcher: ExecutionDispatcher | null = null): Services {
  const llmKeys = new LlmKeysService(p);
  const hub = new ExecutionEventHub(p);
  const registry = buildNodeRegistry({
    agents: p.agents,
    memory: p.memory,
    pendingReviews: p.pendingReviews,
    connectors: p.connectors,
    secrets: p.secrets,
    files: p.files,
  });

  /**
   * Despacho: con binding de Workflows es DURABLE; sin él, INLINE (la ejecución corre en la propia
   * invocación, con el techo de 5 min de CPU). El inline se conserva para `wrangler dev` sin Workflows
   * y para el propio Workflow, que ejecuta el runner dentro de su step y no debe re-encolar.
   */
  const queue = dispatcher;

  const executions = new ExecutionsService(p, registry, queue, hub);
  const triggers = new TriggersService(p, executions);
  const schedules = new SchedulesService(p);
  // El MISMO firmante para las sesiones y para el `oauth_state` de conectores: comparten secreto, que
  // es justo por lo que el middleware de auth rechaza cualquier token que lleve `kind`.
  const signer = new WebCryptoTokenSigner(jwtSecret);
  const auth = new AuthService(signer, p);

  return {
    auth,
    team: new TeamService(p, auth),
    apiKeys: new ApiKeyAuthService(p),
    shares: new SharesService(p),
    webhooks: new WebhooksService(p, executions),
    connectors: new ConnectorsService(p, signer),
    llmKeys,
    hub,
    executions,
    triggers,
    schedules,
    agents: new AgentsService(p, llmKeys),
    workflows: new WorkflowsService(p, triggers, schedules, llmKeys),
    humanEscalation: new HumanEscalationService(p, executions, hub),
  };
}
