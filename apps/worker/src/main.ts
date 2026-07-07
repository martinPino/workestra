import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { WorkflowRunner, type RunInput } from '@core/engine';
import { emptyContext } from '@core/contracts';
import {
  createPrismaClient,
  PrismaExecutionRepository,
  PrismaNodeRunRepository,
  PrismaAgentRepository,
  PrismaPendingReviewRepository,
  PrismaEventStore,
  PrismaWorkflowRepository,
  PrismaConnectorRepository,
  PrismaSecretStore,
  EventStorePublisher,
  InMemoryMemoryStore,
  RedisContextStore,
  RedisWorkspaceUsageRepository,
  RedisEventPublisher,
  CompositeEventPublisher,
  BestEffortPublisher,
  NodeRunProjectorPublisher,
  SystemClock,
  CuidIdGenerator,
} from '@core/infra';
import { createRuntimeRegistry } from '@core/sdk-plugins';
import { createLlmRouter } from '@core/llm';

/**
 * Worker durable de la cola `execution`. Consume jobs encolados por la API, ejecuta con la MISMA
 * maquinaria (agentes/orchestrator/tools), persiste en Postgres, checkpointa el contexto en Redis
 * y publica el stream a Redis pub/sub (el WS gateway hace de puente). Es RESUME-SAFE: al reintentar
 * un job tras una caída, salta los nodos ya completados (NodeRun) — sin duplicar efectos.
 */
async function main(): Promise<void> {
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const HTTP_ALLOWLIST = (process.env.TOOL_HTTP_ALLOWLIST ?? 'example.com,httpbin.org').split(',').map((s) => s.trim());
  const stepDelay = Number(process.env.EXEC_STEP_DELAY_MS ?? 0);
  const ctxTtl = Number(process.env.CTX_TTL_SECONDS ?? 86_400); // igual que la API: aguanta esperas humanas largas

  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const redis = new IORedis(REDIS_URL);
  const pub = new IORedis(REDIS_URL);

  const prisma = createPrismaClient();
  await prisma.$connect();

  const nodeRuns = new PrismaNodeRunRepository(prisma);
  const eventStore = new PrismaEventStore(prisma);
  const registry = createRuntimeRegistry({
    agents: new PrismaAgentRepository(prisma),
    memory: new InMemoryMemoryStore(),
    // Registra el nodo Humano en el worker con el MISMO repo durable que la API (Prisma), de modo
    // que al reanudar en este proceso lea el veredicto persistido y continúe.
    pendingReviews: new PrismaPendingReviewRepository(prisma),
    // Nodo de Conector (M11): mismos repos durables que la API para el dispatch saliente autenticado.
    connectors: new PrismaConnectorRepository(prisma),
    secrets: new PrismaSecretStore(prisma),
    selfBase: process.env.API_SELF_URL ?? 'http://localhost:3001',
    llmRouter: createLlmRouter(),
    httpAllowlist: HTTP_ALLOWLIST,
    stepDelayMs: stepDelay,
  });

  const worker = new Worker<RunInput>(
    'execution',
    async (job) => {
      const input = job.data;
      const executionId = input.executionId!;
      // Resume: nodos ya completados en una ejecución previa del mismo job (tras caída del worker).
      const prior = await nodeRuns.list(executionId);
      const resumeCompleted = prior.filter((r) => r.status === 'succeeded').map((r) => r.nodeKey);
      // Continuidad del stream (M6): el seq sigue tras los eventos ya persistidos, así el replay es
      // monótono a través de pausas humanas y reinicios del worker.
      const startSeq = (await eventStore.lastSeq(executionId)) + 1;

      const runner = new WorkflowRunner({
        executions: new PrismaExecutionRepository(prisma),
        context: new RedisContextStore(redis, ctxTtl),
        events: new CompositeEventPublisher([
          new EventStorePublisher(eventStore), // durable primero (crítico): el replay no pierde eventos
          new BestEffortPublisher(new RedisEventPublisher(pub), 'redis-broadcast'), // red flaky: no debe tumbar la ejecución
          new NodeRunProjectorPublisher(nodeRuns), // misma BD que el store (crítico para resume-safe)
        ]),
        registry,
        clock: new SystemClock(),
        ids: new CuidIdGenerator(),
        // M33: cuota diaria por workspace — el mismo Redis que la API, así los tokens de agentes cuentan.
        usage: new RedisWorkspaceUsageRepository(redis),
      });

      return runner.run({ ...input, resumeCompleted, startSeq });
    },
    // lockDuration/stalledInterval bajos: si el worker cae, el job se detecta atascado y se reintenta rápido.
    { connection, concurrency: 4, lockDuration: 4000, stalledInterval: 2000, maxStalledCount: 5 },
  );

  worker.on('completed', (job) => console.log(`Ejecución OK (job=${job.id})`));
  worker.on('failed', (job, err) => console.error(`Ejecución FALLIDA (job=${job?.id}): ${err?.message}`));

  // --- Consumidor de triggers PROGRAMADOS (M7-B) ---
  // Cada disparo del scheduler crea una ejecución nueva del workflow y la ENCOLA en `execution`
  // (mismo camino durable que la API). El workflow se ancla a su versión publicada en ese momento.
  const executionQueue = new Queue('execution', { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
  const scheduleQueue = new Queue('schedule', { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
  const workflows = new PrismaWorkflowRepository(prisma);
  const scheduleWorker = new Worker<{ scheduleId: string; workflowId: string; workspaceId: string }>(
    'schedule',
    async (job) => {
      const { scheduleId, workflowId } = job.data;
      const wf = await workflows.get(workflowId);
      if (!wf) {
        // El workflow ya no existe (p. ej. borrado en cascada, que elimina la fila del schedule pero
        // NO el repeatable). Auto-limpiamos el scheduler HUÉRFANO para que deje de disparar (evita un
        // zombie que crece en Redis y ejecuta para siempre sin registro en BD).
        console.warn(`[schedule] workflow ${workflowId} no existe; retiro el scheduler huérfano ${scheduleId}.`);
        await scheduleQueue.removeJobScheduler(scheduleId).catch(() => undefined);
        return;
      }
      const runVersion = await workflows.resolveRunVersion(workflowId);
      const initialContext = { ...emptyContext(), variables: { trigger: 'schedule', scheduleId } };
      const execution = await new PrismaExecutionRepository(prisma).create({
        workflowVersionId: runVersion.id,
        workspaceId: wf.workspaceId,
        triggerType: 'cron',
        context: initialContext,
      });
      const input: RunInput = {
        executionId: execution.id,
        workflowVersionId: runVersion.id,
        workspaceId: wf.workspaceId,
        graph: runVersion.graph,
        triggerType: 'cron',
        initialContext,
      };
      await executionQueue.add('run', input, {
        jobId: execution.id,
        attempts: 5,
        backoff: { type: 'fixed', delay: 400 },
        removeOnComplete: 200,
        removeOnFail: 200,
      });
      console.log(`[schedule] ${scheduleId} disparó ejecución ${execution.id} de ${workflowId}`);
    },
    { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 4 },
  );
  scheduleWorker.on('failed', (job, err) => console.error(`[schedule] fallo (job=${job?.id}): ${err?.message}`));

  console.log('Worker durable AgentFlow escuchando las colas "execution" y "schedule"…');
}

void main();
