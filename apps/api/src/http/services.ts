import { AgentsService } from '../agents/agents.service';
import { LlmKeysService } from '../llm-keys/llm-keys.service';
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
}

export function buildServices(p: PersistenceBundle): Services {
  const llmKeys = new LlmKeysService(p);
  return {
    llmKeys,
    agents: new AgentsService(p, llmKeys),
  };
}
