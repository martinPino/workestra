import { Global, Module } from '@nestjs/common';
import type { MemoryEvent } from '@core/contracts';
import IORedis from 'ioredis';
import {
  createPrismaClient,
  InMemoryWorkflowRepository,
  InMemoryNodeRunRepository,
  InMemoryExecutionRepository,
  InMemoryContextStore,
  InMemoryAgentRepository,
  InMemoryMemoryStore,
  PrismaMemoryStore,
  InMemoryPendingReviewRepository,
  InMemoryEventStore,
  InMemorySecretStore,
  InMemoryWebhookRepository,
  InMemoryShareRepository,
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
  PrismaShareRepository,
  PrismaScheduleRepository,
  PrismaConnectorRepository,
  PrismaTriggerBindingRepository,
  InMemoryApiKeyRepository,
  PrismaApiKeyRepository,
  InMemoryWorkspaceUsageRepository,
  RedisWorkspaceUsageRepository,
  InMemoryFileStore,
  RedisFileStore,
  InMemoryAuthRepository,
  PrismaAuthRepository,
  InMemoryTeamRepository,
  PrismaTeamRepository,
  createEmailService,
  hashPassword,
} from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from './bundle';

// El contrato del bundle vive en `bundle.ts` (sin NestJS) porque lo comparten los dos composition
// roots: este módulo (Railway) y `http/composition.ts` (Cloudflare Workers). Se reexporta para no
// romper los ~20 ficheros que ya lo importaban desde aquí.
export { PERSISTENCE, type PersistenceBundle };

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
    memoryScope: null,
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
    memoryScope: null,
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
    memoryScope: null,
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
      // M81: memoria DURABLE y compartida con el worker. Antes se usaba la in-memory incluso en postgres, así
      // que «recordar entre ejecuciones» se perdía al reiniciar y ni siquiera lo veían los dos procesos.
      memory: new PrismaMemoryStore(prisma, memoryEmitter),
      // Revisiones humanas DURABLES: el worker (otro proceso) lee el veredicto persistido al reanudar.
      pendingReviews: new PrismaPendingReviewRepository(prisma),
      events: new PrismaEventStore(prisma),
      secrets: new PrismaSecretStore(prisma),
      webhooks: new PrismaWebhookRepository(prisma),
      shares: new PrismaShareRepository(prisma),
      schedules: new PrismaScheduleRepository(prisma),
      connectors: new PrismaConnectorRepository(prisma),
      triggerBindings: new PrismaTriggerBindingRepository(prisma),
      apiKeys: new PrismaApiKeyRepository(prisma),
      // Cuota diaria por workspace en Redis (compartido con el worker; TTL auto-resetea el contador).
      usage: new RedisWorkspaceUsageRepository(redis),
      // Ficheros efímeros en Redis (compartido con el worker; TTL 48h). M48.
      files: new RedisFileStore(redis),
      // Usuarios/pertenencias durables para login+registro (M73) y gestión de equipo (M74).
      auth: new PrismaAuthRepository(prisma),
      team: new PrismaTeamRepository(prisma),
      email: createEmailService(),
    };
  }
  const memOwnerHash = await hashPassword('owner@acme.dev');
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
    shares: new InMemoryShareRepository(),
    schedules: new InMemoryScheduleRepository(),
    connectors: new InMemoryConnectorRepository(),
    triggerBindings: new InMemoryTriggerBindingRepository(),
    apiKeys: new InMemoryApiKeyRepository(),
    usage: new InMemoryWorkspaceUsageRepository(),
    files: new InMemoryFileStore(),
    // Auth + equipo in-memory (dev/tests): comparten un ÚNICO store de identidad, sembrado con owner@acme.dev
    // (contraseña = su email) en ws_dev, para poder probar login/registro/equipo sin Postgres.
    ...(() => {
      const authRepo = new InMemoryAuthRepository([
        { email: 'owner@acme.dev', name: 'Owner', passwordHash: memOwnerHash, workspaceId: DEFAULT_WORKSPACE, organizationId: 'org_dev', role: 'OWNER' },
      ]);
      return { auth: authRepo, team: new InMemoryTeamRepository(authRepo.identityStore), email: createEmailService() };
    })(),
  };
}

@Global()
@Module({
  providers: [{ provide: PERSISTENCE, useFactory: buildPersistence }],
  exports: [PERSISTENCE],
})
export class PersistenceModule {}
