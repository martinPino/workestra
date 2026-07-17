import { WorkflowRunner } from '@core/engine';
import {
  InMemoryExecutionRepository,
  InMemoryContextStore,
  InMemoryEventPublisher,
  SystemClock,
  CuidIdGenerator,
} from '@core/infra';
import { createDefaultNodeRegistry } from '@core/sdk-plugins';
import { emptyContext, type WorkflowGraph } from '@core/contracts';

/**
 * Demo offline (sin Redis/Postgres): ejecuta un grafo mínimo con adaptadores in-memory
 * e imprime el stream de eventos versionado. `pnpm --filter @app/worker demo`.
 */
const graph: WorkflowGraph = {
  nodes: [
    { key: 'trigger', type: 'trigger', config: {}, position: { x: 0, y: 0 } },
    { key: 'end', type: 'end', config: {}, position: { x: 250, y: 0 } },
  ],
  edges: [{ source: 'trigger', target: 'end' }],
};

async function main(): Promise<void> {
  const events = new InMemoryEventPublisher();
  const runner = new WorkflowRunner({
    executions: new InMemoryExecutionRepository(),
    context: new InMemoryContextStore(),
    events,
    registry: createDefaultNodeRegistry(),
    clock: new SystemClock(),
    ids: new CuidIdGenerator(),
  });

  const id = await runner.run({
    workflowVersionId: 'v_demo',
    workflowId: 'wf_demo',
    workspaceId: 'ws_demo',
    graph,
    triggerType: 'manual',
    initialContext: emptyContext(),
  });

   
  console.log(`Ejecución ${id} completada. Stream de eventos:`);
  for (const e of events.events) {
    const nodeKey = 'nodeKey' in e ? ` ${e.nodeKey}` : '';
    console.log(`  #${e.seq} ${e.type}${nodeKey}`);
  }
}

void main();
