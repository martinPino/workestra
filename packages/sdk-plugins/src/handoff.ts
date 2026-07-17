import type { ExecutionContext, MemoryScope } from '@core/contracts';
import type { IMemoryStore } from '@core/engine';

export interface HandoffRequest {
  fromAgentId: string;
  toAgentId: string;
  task: string;
  context: ExecutionContext;
  /** Whitelist de claves de `variables` a incluir (deny-by-default: nada más se propaga). */
  includeVariableKeys?: string[];
  /** Claves de memoria COMPARTIDA a adjuntar (por ownerId destino), en orden determinista. */
  includeMemoryKeys?: string[];
  /** Tenant del handoff (M81). Sin él NO se adjunta memoria: el almacén es multi-tenant y no podríamos aislarla. */
  workspaceId?: string;
}

export interface Handoff {
  from: string;
  to: string;
  task: string;
  /** Marco compartido de la tarea (siempre incluido): ticket + repositorio. */
  ticket: Record<string, unknown>;
  repository: Record<string, unknown>;
  /** Solo las variables explícitamente autorizadas por la whitelist. */
  variables: Record<string, unknown>;
  /** Entradas de memoria compartida adjuntadas (clave→valor), ordenadas por clave. */
  memory: Array<{ key: string; value: unknown }>;
  summary: string;
}

/**
 * Servicio de handoff (M5): construye la REBANADA de contexto que un agente entrega a otro al
 * delegar. Aplica MÍNIMO PRIVILEGIO —solo el marco de la tarea (ticket/repository) y las variables
 * explícitamente autorizadas viajan; el estado interno de otros agentes NO se filtra por defecto—.
 * La rebanada es DETERMINISTA (claves ordenadas) para que el mismo handoff produzca el mismo
 * resultado, condición necesaria para el replay y las pruebas.
 */
export class HandoffService {
  constructor(private readonly memory?: IMemoryStore) {}

  async slice(req: HandoffRequest): Promise<Handoff> {
    const allowed = [...(req.includeVariableKeys ?? [])].sort();
    const variables: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.context.variables) variables[key] = req.context.variables[key];
    }

    // Memoria de EQUIPO (M81): su owner es el WORKSPACE, no el agente destino —es la memoria que todos los
    // agentes del espacio comparten—. Leerla por `toAgentId` apuntaba a un namespace que nadie escribe: el
    // handoff adjuntaba siempre vacío.
    const memory: Array<{ key: string; value: unknown }> = [];
    if (this.memory && req.workspaceId && req.includeMemoryKeys?.length) {
      const scope: MemoryScope = 'shared';
      for (const key of [...req.includeMemoryKeys].sort()) {
        const value = await this.memory.get(req.workspaceId, scope, req.workspaceId, key);
        if (value !== undefined) memory.push({ key, value });
      }
    }

    const summary =
      `Handoff ${req.fromAgentId}→${req.toAgentId}: "${req.task}" ` +
      `(${allowed.length} variables, ${memory.length} memorias compartidas).`;

    return {
      from: req.fromAgentId,
      to: req.toAgentId,
      task: req.task,
      ticket: req.context.ticket,
      repository: req.context.repository,
      variables,
      memory,
      summary,
    };
  }

  /** Materializa la rebanada como un ExecutionContext acotado, listo para invocar al agente destino. */
  async toContext(req: HandoffRequest): Promise<ExecutionContext> {
    const h = await this.slice(req);
    const memoryRecord: Record<string, unknown> = {};
    for (const { key, value } of h.memory) memoryRecord[key] = value;
    return {
      ...req.context,
      ticket: h.ticket,
      repository: h.repository,
      memory: memoryRecord,
      variables: { ...h.variables, task: h.task },
    };
  }
}
