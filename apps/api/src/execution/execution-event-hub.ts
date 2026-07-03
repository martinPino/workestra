import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { ExecutionEvent } from '@core/contracts';
import { EXECUTION_EVENT_SCHEMA_VERSION } from '@core/contracts';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';

/**
 * Hub del stream de eventos: PERSISTE cada evento en el store durable (fuente de verdad del
 * catch-up/replay), hace fan-out a los suscriptores WS y PROYECTA NodeRun derivado del propio
 * stream. Implementa estructuralmente `IEventPublisher` (publish), así el runner lo usa como
 * puerto de eventos. No mantiene buffer in-memory: el catch-up se sirve del store (M6), evitando
 * un mapa que crecería sin límite durante toda la vida del proceso.
 */
@Injectable()
export class ExecutionEventHub {
  private readonly emitter = new EventEmitter();
  /** Cadena de emisión externa POR ejecución (serializa la asignación de seq). Se autolimpia. */
  private readonly emitChains = new Map<string, Promise<void>>();

  constructor(@Inject(PERSISTENCE) private readonly p: PersistenceBundle) {
    this.emitter.setMaxListeners(0);
  }

  async publish(e: ExecutionEvent): Promise<void> {
    // Persistencia DURABLE del stream (M6). Idempotente por (executionId, seq): en modo cola el
    // worker ya lo persistió y este re-append (vía puente Redis) se ignora sin duplicar.
    await this.p.events.append(e);
    await this.projectNodeRun(e);
    this.emitter.emit('event', e);
  }

  /**
   * Emite un evento generado FUERA del runner (p. ej. la resolución humana). Estampa
   * `schemaVersion`/`at` y deriva `seq` del STORE durable (`lastSeq + 1`): tras un reinicio de la
   * API un seq derivado de un buffer vacío colisionaría con eventos ya persistidos.
   *
   * ATÓMICO por ejecución: encadena las emisiones externas de una misma ejecución para que el
   * `lastSeq()+1` de dos llamadas concurrentes (p. ej. dos resoluciones en paralelo) no calcule el
   * MISMO seq —lo que haría que el append idempotente descartara una en silencio—. La cadena se
   * autolimpia al vaciarse para no crecer sin límite.
   */
  async emit(executionId: string, body: Record<string, unknown>): Promise<void> {
    const prev = this.emitChains.get(executionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const seq = (await this.p.events.lastSeq(executionId)) + 1;
      await this.publish({
        schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
        executionId,
        at: new Date().toISOString(),
        seq,
        ...body,
      } as ExecutionEvent);
    });
    this.emitChains.set(executionId, next);
    try {
      await next;
    } finally {
      if (this.emitChains.get(executionId) === next) this.emitChains.delete(executionId);
    }
  }

  onEvent(fn: (e: ExecutionEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  private async projectNodeRun(e: ExecutionEvent): Promise<void> {
    if (e.type === 'node.started') {
      await this.p.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'running' });
    } else if (e.type === 'node.succeeded') {
      await this.p.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'succeeded' });
    } else if (e.type === 'node.failed') {
      await this.p.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'failed' });
    } else if (e.type === 'human.requested') {
      await this.p.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'waiting_human' });
    }
  }
}
