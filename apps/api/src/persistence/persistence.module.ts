import { Global, Module } from '@nestjs/common';
import type {
  IWorkflowRepository,
  IExecutionRepository,
  IContextStore,
  INodeRunRepository,
  IAgentRepository,
  IMemoryStore,
  IPendingReviewRepository,
  IEventStore,
  ISecretStore,
  IWebhookRepository,
  IScheduleRepository,
  IConnectorRepository,
  ITriggerBindingRepository,
  IApiKeyRepository,
  IWorkspaceUsageRepository,
  IFileStore,
} from '@core/engine';
import type { MemoryEvent } from '@core/contracts';
import IORedis from 'ioredis';
import {
  createPrismaClient,
  PrismaClient,
  InMemoryWorkflowRepository,
  InMemoryNodeRunRepository,
  InMemoryExecutionRepository,
  InMemoryContextStore,
  InMemoryAgentRepository,
  InMemoryMemoryStore,
  InMemoryPendingReviewRepository,
  InMemoryEventStore,
  InMemorySecretStore,
  InMemoryWebhookRepository,
  InMemoryScheduleRepository,
  InMemoryConnectorRepository,
  InMemoryTriggerBindingRepository,
  RedisContextStore,
  PrismaWorkflowRepository,
  PrismaNodeRunRepository,
  PrismaExecutionRepository,
  PrismaAgentRepository,
  PrismaPendingReviewRepository,
  PrismaEventStore,
  PrismaSecretStore,
  PrismaWebhookRepository,
  PrismaScheduleRepository,
  PrismaConnectorRepository,
  PrismaTriggerBindingRepository,
  InMemoryApiKeyRepository,
  PrismaApiKeyRepository,
  InMemoryWorkspaceUsageRepository,
  RedisWorkspaceUsageRepository,
  InMemoryFileStore,
  RedisFileStore,
} from '@core/infra';

export const PERSISTENCE = Symbol('PERSISTENCE');

export interface PersistenceBundle {
  mode: 'memory' | 'postgres';
  workflows: IWorkflowRepository;
  executions: IExecutionRepository;
  context: IContextStore;
  nodeRuns: INodeRunRepository;
  agents: IAgentRepository;
  memory: IMemoryStore;
  pendingReviews: IPendingReviewRepository;
  /** Stream de eventos durable (M6): fuente de verdad del replay y del catch-up tras reinicios. */
  events: IEventStore;
  /** Secretos cifrados en reposo (M7): firmas de webhooks, credenciales, claves de proveedor. */
  secrets: ISecretStore;
  /** Webhooks de ingreso (M7): triggers entrantes firmados que arrancan ejecuciones. */
  webhooks: IWebhookRepository;
  /** Triggers programados (M7-B): registro durable de schedules cron/intervalo. */
  schedules: IScheduleRepository;
  /** Conectores (M11): integraciones OAuth para dispatch saliente autenticado. */
  connectors: IConnectorRepository;
  /** Bindings de disparador (M19): enlace receta↔workflow para triggers sin código (p. ej. Jira). */
  triggerBindings: ITriggerBindingRepository;
  /** Claves de API por workspace (M32): credencial duradera para MCP / apps externas. */
  apiKeys: IApiKeyRepository;
  /** Uso/cuota de tokens LLM por workspace (M33): contador diario para no agotar el presupuesto común. */
  usage: IWorkspaceUsageRepository;
  files: IFileStore;
  prisma?: PrismaClient;
}

const DEFAULT_WORKSPACE = 'ws_dev';

// Agentes de ejemplo para el modo in-memory (el modo postgres usa los del seed).
const SEED_AGENTS = [
  {
    workspaceId: DEFAULT_WORKSPACE,
    name: 'QA Agent',
    description: 'Especialista en Playwright.',
    systemPrompt: 'Eres un ingeniero de QA. Analiza y responde de forma concisa.',
    model: 'mock-1',
    tools: ['mock'],
    memoryScope: 'shared',
    variables: null,
    limits: { maxTokens: 4000 },
    permissions: { role: 'EDITOR' },
    isOrchestrator: false,
  },
  {
    workspaceId: DEFAULT_WORKSPACE,
    name: 'Backend Agent',
    description: 'Especialista en Java/Spring; puede llamar HTTP.',
    systemPrompt: 'Eres un ingeniero backend. Usa herramientas cuando aporten valor.',
    model: 'mock-1',
    tools: ['mock', 'http'],
    memoryScope: 'shared',
    variables: null,
    limits: { maxTokens: 4000 },
    permissions: { role: 'EDITOR' },
    isOrchestrator: false,
  },
  {
    workspaceId: DEFAULT_WORKSPACE,
    name: 'Orchestrator',
    description: 'Agente líder: analiza, planifica y coordina agentes especializados. No ejecuta trabajo técnico.',
    systemPrompt: 'Eres el Orchestrator. Descompón la tarea, delega en agentes y fusiona resultados.',
    model: 'mock-1',
    tools: [],
    memoryScope: 'shared',
    variables: null,
    limits: { maxTokens: 8000 },
    permissions: { role: 'ADMIN' },
    isOrchestrator: true,
  },
];

const memoryEmitter = (e: MemoryEvent): void => {
  // Emite eventos de memoria (M3). En M6 se enlazan al stream de la ejecución para el replay.

  console.log(`[memory] ${e.type} ${e.scope}/${e.ownerId}/${e.key}`);
};

// TTL del checkpoint de contexto en Redis. Amplio (24h por defecto) porque una ejecución en
// WAITING_HUMAN puede esperar horas a que un humano resuelva antes de reanudar.
const CTX_TTL_SECONDS = Number(process.env.CTX_TTL_SECONDS ?? 86_400);

async function buildPersistence(): Promise<PersistenceBundle> {
  const mode = process.env.PERSISTENCE === 'postgres' ? 'postgres' : 'memory';
  const memory = new InMemoryMemoryStore(memoryEmitter);

  if (mode === 'postgres') {
    // 2ª barrera RLS (M10, opt-in): con RLS_ENABLED la API conecta con el rol restringido
    // agentflow_app (sin BYPASSRLS) y fija el tenant por transacción desde el contexto ALS, de modo
    // que las políticas de rls.sql filtran a nivel de BD. Sin la variable, comportamiento previo.
    const rls = process.env.RLS_ENABLED === '1' || process.env.RLS_ENABLED === 'true';
    if (rls && !process.env.DATABASE_URL_RLS) {
      // Fail-safe: sin la URL del rol restringido, Prisma caería al superusuario (BYPASSRLS) y la
      // barrera NO aplicaría en silencio. Preferimos fallar el arranque a dar falsa sensación de RLS.
      throw new Error('RLS_ENABLED requiere DATABASE_URL_RLS (rol agentflow_app sin BYPASSRLS).');
    }
    const prisma = createPrismaClient(rls ? { rls: true, url: process.env.DATABASE_URL_RLS } : {});
    await prisma.$connect();
    if (rls) console.log('[persistence] RLS activo (rol restringido + tenant por petición)');
    // Context DURABLE y COMPARTIDO en Redis: la API y el worker leen/escriben el mismo checkpoint
    // (`ctx:<execId>`), condición para que la reanudación humana funcione entre procesos.
    const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    return {
      mode,
      prisma,
      workflows: new PrismaWorkflowRepository(prisma),
      executions: new PrismaExecutionRepository(prisma),
      context: new RedisContextStore(redis, CTX_TTL_SECONDS),
      nodeRuns: new PrismaNodeRunRepository(prisma),
      agents: new PrismaAgentRepository(prisma),
      memory,
      // Revisiones humanas DURABLES: el worker (otro proceso) lee el veredicto persistido al reanudar.
      pendingReviews: new PrismaPendingReviewRepository(prisma),
      events: new PrismaEventStore(prisma),
      secrets: new PrismaSecretStore(prisma),
      webhooks: new PrismaWebhookRepository(prisma),
      schedules: new PrismaScheduleRepository(prisma),
      connectors: new PrismaConnectorRepository(prisma),
      triggerBindings: new PrismaTriggerBindingRepository(prisma),
      apiKeys: new PrismaApiKeyRepository(prisma),
      // Cuota diaria por workspace en Redis (compartido con el worker; TTL auto-resetea el contador).
      usage: new RedisWorkspaceUsageRepository(redis),
      // Ficheros efímeros en Redis (compartido con el worker; TTL 48h). M48.
      files: new RedisFileStore(redis),
    };
  }
  return {
    mode,
    workflows: new InMemoryWorkflowRepository(),
    executions: new InMemoryExecutionRepository(),
    context: new InMemoryContextStore(),
    nodeRuns: new InMemoryNodeRunRepository(),
    agents: new InMemoryAgentRepository(SEED_AGENTS),
    memory,
    pendingReviews: new InMemoryPendingReviewRepository(),
    events: new InMemoryEventStore(),
    secrets: new InMemorySecretStore(),
    webhooks: new InMemoryWebhookRepository(),
    schedules: new InMemoryScheduleRepository(),
    connectors: new InMemoryConnectorRepository(),
    triggerBindings: new InMemoryTriggerBindingRepository(),
    apiKeys: new InMemoryApiKeyRepository(),
    usage: new InMemoryWorkspaceUsageRepository(),
    files: new InMemoryFileStore(),
  };
}

@Global()
@Module({
  providers: [{ provide: PERSISTENCE, useFactory: buildPersistence }],
  exports: [PERSISTENCE],
})
export class PersistenceModule {}
