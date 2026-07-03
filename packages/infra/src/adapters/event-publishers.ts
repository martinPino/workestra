import type { ExecutionEvent } from '@core/contracts';
import type { IEventPublisher, INodeRunRepository } from '@core/engine';

/** Reenvía cada evento a varios publicadores (p.ej. store durable + Redis + proyector NodeRun). */
export class CompositeEventPublisher implements IEventPublisher {
  constructor(private readonly publishers: IEventPublisher[]) {}
  async publish(e: ExecutionEvent): Promise<void> {
    for (const p of this.publishers) await p.publish(e);
  }
}

/**
 * Envuelve un publicador NO crítico (p. ej. el broadcast a Redis): si falla, lo registra y CONTINÚA
 * en vez de romper el fan-out. Así un hipo transitorio de Redis no tumba una ejecución cuyo evento
 * ya quedó DURABLE en el store (la UI se recupera vía polling del store). Los sinks críticos
 * (store, proyección de NodeRun sobre la misma BD) NO se envuelven: si fallan, la ejecución
 * debe fallar/reintentar.
 */
export class BestEffortPublisher implements IEventPublisher {
  constructor(
    private readonly inner: IEventPublisher,
    private readonly label: string,
  ) {}
  async publish(e: ExecutionEvent): Promise<void> {
    try {
      await this.inner.publish(e);
    } catch (err) {
      console.warn(`[events] sink '${this.label}' falló (best-effort, evento ya durable): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Proyecta NodeRun (estado por nodo) de forma durable a partir del stream. El worker lo usa para
 * que, tras un reinicio, el runner sepa qué nodos ya se completaron (resume-safe).
 */
export class NodeRunProjectorPublisher implements IEventPublisher {
  constructor(private readonly nodeRuns: INodeRunRepository) {}
  async publish(e: ExecutionEvent): Promise<void> {
    if (e.type === 'node.started') {
      await this.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'running' });
    } else if (e.type === 'node.succeeded') {
      await this.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'succeeded', finishedAt: new Date() });
    } else if (e.type === 'node.failed') {
      await this.nodeRuns.upsert({ executionId: e.executionId, nodeKey: e.nodeKey, status: 'failed', finishedAt: new Date() });
    }
  }
}
