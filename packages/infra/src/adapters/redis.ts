import type { Redis } from 'ioredis';
import type { ExecutionContext, ExecutionEvent } from '@core/contracts';
import { emptyContext } from '@core/contracts';
import type { IContextStore, IEventPublisher } from '@core/engine';

/** Context store en Redis (checkpoint por ejecución). */
export class RedisContextStore implements IContextStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 3600,
  ) {}

  private key(id: string): string {
    return `ctx:${id}`;
  }

  async load(id: string): Promise<ExecutionContext> {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as ExecutionContext) : emptyContext();
  }

  async checkpoint(id: string, ctx: ExecutionContext): Promise<void> {
    await this.redis.set(this.key(id), JSON.stringify(ctx), 'EX', this.ttlSeconds);
  }
}

/** Publica eventos de ejecución a un canal Redis pub/sub; el WS gateway hace fan-out. */
export class RedisEventPublisher implements IEventPublisher {
  constructor(
    private readonly pub: Redis,
    private readonly channelPrefix = 'exec',
  ) {}

  async publish(e: ExecutionEvent): Promise<void> {
    await this.pub.publish(`${this.channelPrefix}:${e.executionId}`, JSON.stringify(e));
  }
}
