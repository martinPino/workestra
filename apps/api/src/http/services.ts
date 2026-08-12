import { AgentsService } from '../agents/agents.service';
import { LlmKeysService } from '../llm-keys/llm-keys.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ExecutionsService } from '../execution/executions.service';
import { ExecutionEventHub } from '../execution/execution-event-hub';
import { HumanEscalationService } from '../execution/human-escalation.service';
import { TriggersService } from '../triggers/triggers.service';
import { SchedulesService } from '../schedules/schedules.service';
import { buildNodeRegistry } from '../execution/node-registry';
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
}

export function buildServices(p: PersistenceBundle): Services {
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
   * `null` = despacho INLINE: la ejecución corre dentro de esta misma invocación en vez de encolarse.
   *
   * Es interino y tiene un límite duro: un Worker tiene 5 min de CPU, así que un workflow largo o con
   * muchos nodos se corta a mitad. La fase 4 lo sustituye por Cloudflare Workflows, donde cada nodo es
   * un step con wall-clock ilimitado. Hasta entonces esto sirve para el editor y para runs cortos, NO
   * para producción.
   */
  const queue = null;

  const executions = new ExecutionsService(p, registry, queue, hub);
  const triggers = new TriggersService(p, executions);
  const schedules = new SchedulesService(p, queue);

  return {
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
