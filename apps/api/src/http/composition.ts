import type { MemoryEvent } from '@core/contracts';
import {
  PrismaWorkflowRepository,
  PrismaExecutionRepository,
  PrismaNodeRunRepository,
  PrismaAgentRepository,
  PrismaPendingReviewRepository,
  PrismaEventStore,
  PrismaSecretStore,
  PrismaWebhookRepository,
  PrismaShareRepository,
  PrismaScheduleRepository,
  PrismaConnectorRepository,
  PrismaTriggerBindingRepository,
  PrismaApiKeyRepository,
  PrismaAuthRepository,
  PrismaTeamRepository,
  PrismaMemoryStore,
} from '@core/infra/postgres';
import {
  createHyperdrivePrismaClient,
  createHttpEmailService,
  R2FileStore,
  DurableObjectContextStore,
  DurableObjectWorkspaceUsageRepository,
  type PoolLike,
} from '@core/infra/cloudflare';
import type { PersistenceBundle } from '../persistence/bundle';
import type { Env } from './env';

const memoryEmitter = (e: MemoryEvent): void => {
  console.log(`[memory] ${e.type} ${e.scope}/${e.ownerId}/${e.key}`);
};

/**
 * Composition root del Worker: el equivalente de `buildPersistence()` del módulo de Nest, pero ligado a
 * `env` en vez de a `process.env`, y sin modo `memory` — en Cloudflare siempre es Postgres.
 *
 * Se construye POR PETICIÓN, no una vez al arrancar. Un isolate puede morir en cualquier momento y no
 * hay ciclo de vida al que colgar un pool: cachear el cliente entre peticiones deja conexiones colgadas
 * cuando el isolate se recicla. Es barato porque quien mantiene el pool caliente es Hyperdrive, no el
 * Worker.
 *
 * Devuelve también el pool: hay que cerrarlo al terminar la petición (ver `closeBundle`).
 */
export function buildCloudflarePersistence(env: Env): { bundle: PersistenceBundle; pool: PoolLike } {
  const { prisma, pool } = createHyperdrivePrismaClient(env.HYPERDRIVE);

  const bundle: PersistenceBundle = {
    mode: 'postgres',
    prisma,
    workflows: new PrismaWorkflowRepository(prisma),
    executions: new PrismaExecutionRepository(prisma),
    nodeRuns: new PrismaNodeRunRepository(prisma),
    agents: new PrismaAgentRepository(prisma),
    memory: new PrismaMemoryStore(prisma, memoryEmitter),
    pendingReviews: new PrismaPendingReviewRepository(prisma),
    events: new PrismaEventStore(prisma),
    secrets: new PrismaSecretStore(prisma),
    webhooks: new PrismaWebhookRepository(prisma),
    shares: new PrismaShareRepository(prisma),
    schedules: new PrismaScheduleRepository(prisma),
    connectors: new PrismaConnectorRepository(prisma),
    triggerBindings: new PrismaTriggerBindingRepository(prisma),
    apiKeys: new PrismaApiKeyRepository(prisma),
    auth: new PrismaAuthRepository(prisma),
    team: new PrismaTeamRepository(prisma),

    // Los tres adaptadores que cambian de tecnología. El resto son los MISMOS de Railway: hablan con el
    // PrismaClient que se les inyecta y no saben en qué plataforma corren.
    context: new DurableObjectContextStore(env.EXECUTION_ROOM),
    usage: new DurableObjectWorkspaceUsageRepository(env.WORKSPACE_USAGE),
    files: new R2FileStore(env.FILES),

    // Solo proveedores HTTP: el camino SMTP necesita un socket TCP que aquí no existe.
    email: createHttpEmailService(process.env as Record<string, string | undefined>),
  };

  return { bundle, pool };
}

/**
 * Cierra el pool de la petición. Va en `ctx.waitUntil()` para no retrasar la respuesta, pero SÍ hay que
 * llamarlo: un pool sin cerrar mantiene abierta una conexión de un isolate que ya no existe, y
 * Hyperdrive las cuenta.
 */
export async function closeBundle(pool: PoolLike): Promise<void> {
  try {
    await pool.end();
  } catch (e) {
    console.warn('[api] no pude cerrar el pool:', e instanceof Error ? e.message : String(e));
  }
}
