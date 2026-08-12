import type { ExecutionContext, ExecutionEvent } from '@core/contracts';
import { emptyContext } from '@core/contracts';
import type { IContextStore, IEventPublisher } from '@core/engine';
import type { DurableObjectNamespaceLike, DurableObjectStubLike } from './bindings';
import { EXECUTION_ROOM, executionRoomName } from './protocol';

/** Resuelve el stub del `ExecutionRoom` de una ejecución. Mismo id ⇒ mismo objeto, siempre. */
function room(ns: DurableObjectNamespaceLike, executionId: string): DurableObjectStubLike {
  return ns.get(ns.idFromName(executionRoomName(executionId)));
}

/**
 * Checkpoint del contexto en el Durable Object de la ejecución (sustituye a `RedisContextStore`).
 *
 * Gana una propiedad que Redis no daba: el DO es de UN solo hilo y serializa sus peticiones, así que dos
 * escritores concurrentes (el Workflow que ejecuta y la API que reanuda una pausa humana) no pueden
 * pisarse a mitad de un checkpoint. Con Redis eso era un `SET` de último-en-llegar-gana.
 *
 * No hay TTL: el ciclo de vida lo cierra `deleteAll()` en el DO cuando la ejecución termina. El
 * `CTX_TTL_SECONDS` de Redis existía porque un checkpoint huérfano se quedaba ahí para siempre.
 */
export class DurableObjectContextStore implements IContextStore {
  constructor(private readonly ns: DurableObjectNamespaceLike) {}

  async load(executionId: string): Promise<ExecutionContext> {
    const res = await room(this.ns, executionId).fetch(EXECUTION_ROOM.context);
    // 404 = ejecución nueva sin checkpoint todavía; es el caso normal del primer nodo, no un error.
    if (res.status === 404) return emptyContext();
    if (!res.ok) throw new Error(`context store: el DO respondió ${res.status} al cargar ${executionId}`);
    return (await res.json()) as ExecutionContext;
  }

  async checkpoint(executionId: string, ctx: ExecutionContext): Promise<void> {
    const res = await room(this.ns, executionId).fetch(EXECUTION_ROOM.checkpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    // Un checkpoint perdido rompe la reanudación (se reejecutaría con contexto viejo): esto SÍ lanza.
    if (!res.ok) throw new Error(`context store: el DO respondió ${res.status} al checkpointear ${executionId}`);
  }
}

/**
 * Publica el stream de la ejecución en su Durable Object, que hace el fan-out a los WebSocket suscritos
 * (sustituye a `RedisEventPublisher` + el puente `RedisEventBridge`: el DO es a la vez el bus y el
 * gateway, así que desaparece un salto y el proceso que lo mantenía).
 *
 * Igual que con Redis, este sink es NO crítico: se envuelve en `BestEffortPublisher` porque el evento ya
 * quedó durable en el `IEventStore` y la consola se recupera por polling.
 */
export class DurableObjectEventPublisher implements IEventPublisher {
  constructor(private readonly ns: DurableObjectNamespaceLike) {}

  async publish(e: ExecutionEvent): Promise<void> {
    const res = await room(this.ns, e.executionId).fetch(EXECUTION_ROOM.publish, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(e),
    });
    if (!res.ok) throw new Error(`event publisher: el DO respondió ${res.status} para ${e.executionId}`);
  }
}
