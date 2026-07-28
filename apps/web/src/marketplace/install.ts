import { api } from '../lib/api';
import { docToWorkflowGraph } from '../graph';
import type { GraphDoc } from '../editor/model';
import type { MarketItem, InstallRecipe } from './catalog';

export interface InstallResult {
  workflowId?: string;
  agentIds: string[];
}

/** Proveedores requeridos por el item que el usuario aún NO tiene conectados. */
export function missingConnectors(item: MarketItem, connectedProviders: Set<string>): string[] {
  return item.connectors.filter((p) => !connectedProviders.has(p));
}

/** Copia el grafo resolviendo `agentRef`→agentId y `provider`→connectorId (si el conector existe). */
function resolveDoc(doc: GraphDoc, idByRef: Map<string, string>, connectorIdByProvider: Map<string, string>): GraphDoc {
  const nodes = doc.nodes.map((n) => {
    const config = { ...(n.config as Record<string, unknown>) };
    if (typeof config.agentRef === 'string') {
      const id = idByRef.get(config.agentRef);
      if (id) config.agentId = id;
      delete config.agentRef;
    }
    if (typeof config.provider === 'string') {
      const cid = connectorIdByProvider.get(config.provider);
      if (cid) config.connectorId = cid; // si no hay conector, se queda como estaba (null) y el editor pedirá elegirlo
      delete config.provider;
    }
    return { ...n, config };
  });
  return { ...doc, nodes };
}

/**
 * Instala una RECETA (M75): crea sus agentes, resuelve las referencias en el grafo y crea el workflow ya
 * cableado. `connectorIdByProvider` mapea proveedor→id de un conector YA conectado del usuario, para dejar
 * los nodos de conector listos cuando sea posible. Usa las APIs existentes (crear agente/workflow).
 *
 * Se extrajo de `installItem` (M85) para que el importador de enlaces compartidos reuse EXACTAMENTE el mismo
 * camino: una receta armada desde el doc portable compartido entra por aquí igual que la del marketplace.
 */
export async function installRecipe(recipe: InstallRecipe, connectorIdByProvider: Map<string, string>): Promise<InstallResult> {
  const idByRef = new Map<string, string>();
  const agentIds: string[] = [];

  for (const a of recipe.agents ?? []) {
    const created = await api.createAgent({
      name: a.name,
      description: a.role,
      systemPrompt: a.systemPrompt,
      model: a.model,
      tools: a.tools,
      mcpServers: a.mcpServers,
      isOrchestrator: a.isOrchestrator,
    });
    idByRef.set(a.ref, created.id);
    agentIds.push(created.id);
  }

  let workflowId: string | undefined;
  if (recipe.workflow) {
    const doc = resolveDoc(recipe.workflow.doc, idByRef, connectorIdByProvider);
    const wf = await api.createWorkflow(recipe.workflow.name, docToWorkflowGraph(doc));
    workflowId = wf.id;
  }

  return { workflowId, agentIds };
}

/** Instala un item del marketplace (M75): envoltorio fino sobre `installRecipe` con la receta del item. */
export async function installItem(item: MarketItem, connectorIdByProvider: Map<string, string>): Promise<InstallResult> {
  return installRecipe(item.install, connectorIdByProvider);
}
