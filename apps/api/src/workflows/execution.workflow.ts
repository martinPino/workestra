import type { RunInput } from '@core/engine';
import { buildCloudflarePersistence, closeBundle } from '../http/composition';
import { buildServices } from '../http/services';
import type { Env } from '../http/env';

/**
 * `ExecutionWorkflow`: la ejecución durable sobre Cloudflare Workflows. Sustituye a `apps/worker`
 * (proceso BullMQ) — mismo `WorkflowRunner`, distinto quien le da la vuelta al bucle.
 *
 * Lo que aporta frente a BullMQ:
 *  - **Wall-clock por step ILIMITADO.** Un nodo agente que espera minutos al LLM ya no compite con el
 *    techo de 5 min de CPU de una invocación: la CPU solo cuenta mientras se ejecuta código.
 *  - **Durabilidad por step, no por job.** BullMQ reintentaba el job entero y el runner tenía que
 *    saltarse a mano los nodos ya completados leyendo `NodeRun`. Aquí un step cerrado no se repite.
 *
 * `NodeRun` se mantiene porque la consola lo lee, pero deja de ser el mecanismo de idempotencia.
 *
 * NOTA sobre el límite de 1 MiB por resultado de step: el `ExecutionContext` crece con las salidas de
 * los nodos, así que NO viaja entre steps. Vive en el Durable Object de la ejecución
 * (`DurableObjectContextStore`) y los steps solo mueven el `executionId`.
 */

/** Lo que Workflows pasa al entrypoint. Se tipa a mano por lo mismo que el resto: globals en conflicto. */
export interface WorkflowEvent<T> {
  payload: T;
}

export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export class ExecutionWorkflow {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}

  async run(event: WorkflowEvent<RunInput>, step: WorkflowStep): Promise<{ executionId: string; status: string }> {
    const input = event.payload;
    const { bundle, pool } = buildCloudflarePersistence(this.env);

    try {
      /**
       * Un solo step envuelve el runner completo, no uno por nodo.
       *
       * Es deliberado: el `WorkflowRunner` YA planifica el DAG, hace fan-out en paralelo, fan-in
       * determinista y aplica retries y timeouts por nodo. Partirlo en un step por nodo obligaría a
       * reimplementar el planificador aquí fuera y a duplicar esa lógica — exactamente lo que la
       * arquitectura evita al mantener el motor puro. Se paga con reintentos de grano más grueso, que
       * el runner ya cubre con su propio resume-safe vía `NodeRun`.
       */
      const result = await step.do(`run:${input.executionId ?? 'nuevo'}`, async () => {
        const services = buildServices(bundle, this.env.JWT_SECRET ?? '');
        return services.executions.runToCompletion(input);
      });
      return result as { executionId: string; status: string };
    } finally {
      await closeBundle(pool);
    }
  }
}
