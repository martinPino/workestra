import type { RunInput } from '@core/engine';

/**
 * Despacho de ejecuciones, como PUERTO. Sustituye a la cola BullMQ.
 *
 * `null` sigue significando INLINE (la ejecución corre en la propia invocación), igual que antes; una
 * implementación significa DURABLE. Lo que cambia por debajo es quién aporta la durabilidad: antes
 * BullMQ con reintentos y `jobId` para deduplicar, ahora una instancia de Cloudflare Workflows, cuyo
 * id cumple el mismo papel de dedupe.
 */
export interface ExecutionDispatcher {
  /**
   * Encola una ejecución. `key` es el id de la instancia y DEDUPLICA: dos llamadas con la misma clave
   * no arrancan dos ejecuciones — es lo que hacía `jobId` en BullMQ y lo que evita que un reintento
   * del cliente duplique efectos externos.
   */
  dispatch(key: string, input: RunInput): Promise<void>;
}

/** Binding de Workflows: lo mínimo que se usa de él. */
export interface WorkflowBindingLike {
  create(options: { id?: string; params?: unknown }): Promise<unknown>;
}

/**
 * Despacho sobre Cloudflare Workflows.
 *
 * Los reintentos y el backoff ya no se configuran aquí: los declara cada `step.do()` dentro del
 * Workflow, que es donde importan — reintentar UN nodo en vez de la ejecución entera. Es una mejora
 * real sobre BullMQ, donde `attempts: 5` reintentaba el job completo y el runner tenía que saltarse a
 * mano los nodos ya hechos.
 */
export class WorkflowsDispatcher implements ExecutionDispatcher {
  constructor(private readonly binding: WorkflowBindingLike) {}

  async dispatch(key: string, input: RunInput): Promise<void> {
    try {
      await this.binding.create({ id: key, params: input });
    } catch (e) {
      // Una instancia con ese id ya existe = el dedupe funcionando, no un fallo: es exactamente el
      // caso que `jobId` cubría en BullMQ (reintento del cliente sobre la misma ejecución).
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|duplicate/i.test(msg)) return;
      throw e;
    }
  }
}
