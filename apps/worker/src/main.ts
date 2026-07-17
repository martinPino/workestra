import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { WorkflowRunner, type RunInput, type ScheduleRecord } from '@core/engine';
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
  PrismaScheduleRepository,
  PrismaTriggerBindingRepository,
  PrismaSecretStore,
  EventStorePublisher,
  PrismaMemoryStore,
  RedisContextStore,
  RedisWorkspaceUsageRepository,
  RedisEventPublisher,
  CompositeEventPublisher,
  BestEffortPublisher,
  NodeRunProjectorPublisher,
  SystemClock,
  CuidIdGenerator,
  McpToolResolver,
  RedisFileStore,
} from '@core/infra';
import { createRuntimeRegistry, resolveConnectorToken, pollDriveFiles, fetchDriveFileBytes, pollSentryIssues } from '@core/sdk-plugins';
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
  // Instancias compartidas: el runtime Y el sondeo de triggers (M52) usan los mismos conectores/secretos/ficheros.
  const connectors = new PrismaConnectorRepository(prisma);
  const secrets = new PrismaSecretStore(prisma);
  const triggerBindings = new PrismaTriggerBindingRepository(prisma); // M80: sondeo de Sentry (red de seguridad del webhook)
  const fileStore = new RedisFileStore(redis); // M48: mismo almacén de ficheros que la API (Redis compartido)
  const registry = createRuntimeRegistry({
    agents: new PrismaAgentRepository(prisma),
    // M81: memoria DURABLE (Postgres), la MISMA que usa la API: sin esto, lo que un agente «recuerda» al
    // ejecutarse en el worker moría con el proceso y la API nunca lo veía.
    memory: new PrismaMemoryStore(prisma),
    // Registra el nodo Humano en el worker con el MISMO repo durable que la API (Prisma), de modo
    // que al reanudar en este proceso lea el veredicto persistido y continúe.
    pendingReviews: new PrismaPendingReviewRepository(prisma),
    // Nodo de Conector (M11): mismos repos durables que la API para el dispatch saliente autenticado.
    connectors,
    secrets,
    selfBase: process.env.API_SELF_URL ?? 'http://localhost:3001',
    llmRouter: createLlmRouter(),
    httpAllowlist: HTTP_ALLOWLIST,
    mcp: new McpToolResolver(secrets), // M40/M45: tools MCP + credencial del servidor conectado
    files: fileStore,
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
  const schedules = new PrismaScheduleRepository(prisma);
  const executionRepo = new PrismaExecutionRepository(prisma);

  // Encola UNA ejecución del workflow (anclada a su versión publicada) con variables iniciales extra.
  async function enqueueWorkflowRun(wf: { id: string; workspaceId: string }, extraVars: Record<string, unknown>): Promise<string> {
    const runVersion = await workflows.resolveRunVersion(wf.id);
    const initialContext = { ...emptyContext(), variables: { ...extraVars } };
    const execution = await executionRepo.create({
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
    return execution.id;
  }

  // M52: sondea la fuente (hoy Google Drive) y encola una ejecución por cada fichero NUEVO desde el último
  // sondeo (cursor en Redis). Descarga los bytes al file store y deja el `FileRef` en `{{file:trigger}}` para
  // que el flujo (extraer texto → LLM → CRM) lo consuma directo, como el trigger de Drive de n8n.
  async function firePollTrigger(schedule: ScheduleRecord, wf: { id: string; workspaceId: string }): Promise<void> {
    const poll = schedule.poll;
    if (!poll) return;
    if (poll.provider !== 'google-drive') {
      console.warn(`[schedule] ${schedule.id}: proveedor de sondeo no soportado (${poll.provider}).`);
      return;
    }
    const cursorKey = `af:drivepoll:${schedule.id}`;
    const cursor = await redis.get(cursorKey);
    const nowIso = new Date().toISOString();
    if (!cursor) {
      // Primer sondeo: fija la línea base «desde ahora» (no dispara por ficheros preexistentes).
      await redis.set(cursorKey, nowIso);
      console.log(`[schedule] ${schedule.id}: sondeo Drive inicializado en ${nowIso}.`);
      return;
    }
    const resolved = await resolveConnectorToken(connectors, secrets, poll.connectorId, schedule.workspaceId);
    if (!resolved) {
      console.warn(`[schedule] ${schedule.id}: conector ${poll.connectorId} no conectado; salto el sondeo.`);
      return;
    }
    const { files, newSince } = await pollDriveFiles({ token: resolved.token, folderId: poll.folderId, sinceIso: cursor });
    for (const f of files) {
      // FileRef para el contexto: por defecto solo metadatos; si podemos descargar los bytes, van al store.
      let fileRef: Record<string, unknown> = { driveId: f.id, name: f.name, mimeType: f.mimeType };
      try {
        const bytes = await fetchDriveFileBytes({ token: resolved.token, fileId: f.id, mimeType: f.mimeType });
        if (bytes) {
          const ref = await fileStore.put(schedule.workspaceId, { name: f.name, mimeType: f.mimeType, bytes });
          fileRef = { ...ref, driveId: f.id };
        }
      } catch (e) {
        console.warn(`[schedule] ${schedule.id}: no pude descargar «${f.name}»: ${e instanceof Error ? e.message : String(e)}`);
      }
      const execId = await enqueueWorkflowRun(wf, {
        trigger: 'drive',
        scheduleId: schedule.id,
        'file:trigger': fileRef,
        driveFile: { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime },
      });
      console.log(`[schedule] ${schedule.id}: Drive «${f.name}» → ejecución ${execId}.`);
    }
    // Avanza el cursor SOLO tras encolar el lote (si algo falla antes, se reintenta el mismo lote).
    await redis.set(cursorKey, newSince);
  }

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
      const schedule = await schedules.get(scheduleId);
      // M52: un schedule con config `poll` es un SONDEO — lista los ficheros nuevos y encola uno por cada uno.
      if (schedule?.poll) {
        await firePollTrigger(schedule, wf);
        return;
      }
      const execId = await enqueueWorkflowRun(wf, { trigger: 'schedule', scheduleId });
      console.log(`[schedule] ${scheduleId} disparó ejecución ${execId} de ${workflowId}`);
    },
    { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 4 },
  );
  scheduleWorker.on('failed', (job, err) => console.error(`[schedule] fallo (job=${job?.id}): ${err?.message}`));

  // M80: RED DE SEGURIDAD del trigger de Sentry. Cada 60s sondea los proyectos con un trigger
  // `sentry.issue_created` activo y encola una ejecución por issue NUEVO (cursor por `firstSeen` + dedup por id
  // en Redis, así no duplica con el webhook si este también llega). Multi-región (UE) vía pollSentryIssues.
  let sentryPolling = false;
  async function pollSentryBindings(): Promise<void> {
    if (sentryPolling) return; // no solapar corridas
    sentryPolling = true;
    try {
      const active = await triggerBindings.listActive();
      const groups = new Map<string, { connectorId: string; project: string; workspaceId: string; workflowIds: Set<string> }>();
      for (const b of active) {
        if (b.eventId !== 'sentry.issue_created') continue;
        const project = String((b.params as Record<string, unknown>).project ?? '');
        if (!project) continue;
        const key = `${b.workspaceId}::${b.connectorId}::${project}`;
        const g = groups.get(key) ?? { connectorId: b.connectorId, project, workspaceId: b.workspaceId, workflowIds: new Set<string>() };
        g.workflowIds.add(b.workflowId);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const cursorKey = `af:sentrypoll:${g.workspaceId}:${g.project}`;
        const cursor = await redis.get(cursorKey);
        const nowIso = new Date().toISOString();
        if (!cursor) {
          await redis.set(cursorKey, nowIso); // línea base «desde ahora»: no dispara por issues preexistentes
          continue;
        }
        const resolved = await resolveConnectorToken(connectors, secrets, g.connectorId, g.workspaceId);
        if (!resolved) continue;
        const { issues, newSince } = await pollSentryIssues({ token: resolved.token, project: g.project, sinceIso: cursor });
        for (const issue of issues) {
          // Dedup por id (NX): si el webhook ya lo disparó, no repetimos (y evita doble disparo entre corridas).
          const claimed = await redis.set(`af:sentryissue:${issue.id}`, '1', 'EX', 86_400, 'NX');
          if (!claimed) continue;
          for (const wfId of g.workflowIds) {
            const wf = await workflows.get(wfId);
            if (!wf) continue;
            const execId = await enqueueWorkflowRun({ id: wfId, workspaceId: g.workspaceId }, { trigger: 'sentry', issue, issueId: issue.id });
            console.log(`[sentry-poll] ${g.project} issue ${issue.shortId || issue.id} → ejecución ${execId}`);
          }
        }
        await redis.set(cursorKey, newSince); // avanza el cursor SOLO tras encolar el lote
      }
    } catch (e) {
      console.error('[sentry-poll]', e instanceof Error ? e.message : String(e));
    } finally {
      sentryPolling = false;
    }
  }
  setInterval(() => void pollSentryBindings(), 60_000);
  void pollSentryBindings(); // primera pasada al arrancar (fija la línea base de cada proyecto)

  console.log('Worker durable AgentFlow escuchando las colas "execution" y "schedule"…');
}

void main();
