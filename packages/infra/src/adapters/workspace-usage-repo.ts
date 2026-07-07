import type IORedis from 'ioredis';
import type { IWorkspaceUsageRepository } from '@core/engine';

/** Clave de ventana diaria (UTC): AAAA-MM-DD. El contador se resetea al cambiar de día. */
function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Contador de uso por workspace in-memory (dev/tests). Se resetea al cambiar de día natural. */
export class InMemoryWorkspaceUsageRepository implements IWorkspaceUsageRepository {
  private readonly counters = new Map<string, number>();

  async add(workspaceId: string, tokens: number): Promise<number> {
    const k = `${workspaceId}:${dayKey()}`;
    const total = (this.counters.get(k) ?? 0) + Math.max(0, Math.round(tokens));
    this.counters.set(k, total);
    return total;
  }
  async todayTokens(workspaceId: string): Promise<number> {
    return this.counters.get(`${workspaceId}:${dayKey()}`) ?? 0;
  }
}

/**
 * Contador de uso por workspace en Redis (compartido por API y worker vía REDIS_URL). Usa una clave por
 * día con TTL (48h) para que se limpie sola: la cuota diaria se resetea al cambiar de día natural.
 */
export class RedisWorkspaceUsageRepository implements IWorkspaceUsageRepository {
  constructor(
    private readonly redis: IORedis,
    private readonly ttlSeconds = 172_800,
  ) {}

  private key(workspaceId: string): string {
    return `usage:${workspaceId}:${dayKey()}`;
  }

  async add(workspaceId: string, tokens: number): Promise<number> {
    const k = this.key(workspaceId);
    const total = await this.redis.incrby(k, Math.max(0, Math.round(tokens)));
    await this.redis.expire(k, this.ttlSeconds);
    return total;
  }
  async todayTokens(workspaceId: string): Promise<number> {
    const v = await this.redis.get(this.key(workspaceId));
    return v ? Number(v) : 0;
  }
}
