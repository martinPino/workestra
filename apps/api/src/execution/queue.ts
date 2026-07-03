import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { ExecutionEvent } from '@core/contracts';
import { ExecutionEventHub } from './execution-event-hub';

export const EXECUTION_QUEUE = Symbol('EXECUTION_QUEUE');
export const SCHEDULE_QUEUE = Symbol('SCHEDULE_QUEUE');

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Modo de despacho. `DISPATCH` es un OVERRIDE explícito (`queue` | `inline`). Sin él, el modo DURABLE
 * (PERSISTENCE=postgres, que ya exige Redis y worker) implica `queue`, de modo que los triggers
 * programados y la ejecución durable funcionan SIN flags ni reinicios manuales — todo gestionable
 * desde la UI. El modo memoria (lite) queda en `inline`.
 */
export const dispatchMode = (): 'inline' | 'queue' => {
  if (process.env.DISPATCH === 'queue') return 'queue';
  if (process.env.DISPATCH === 'inline') return 'inline';
  return process.env.PERSISTENCE === 'postgres' ? 'queue' : 'inline';
};

/** Crea la cola BullMQ solo en modo `DISPATCH=queue`; en `inline` devuelve null. */
export function createExecutionQueue(): Queue | null {
  if (dispatchMode() !== 'queue') return null;
  return new Queue('execution', { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
}

/**
 * Cola de triggers PROGRAMADOS (M7-B). Aloja los repeatable jobs (cron/intervalo); el worker los
 * consume y arranca una ejecución en cada disparo. Solo en `DISPATCH=queue` (necesita BullMQ).
 */
export function createScheduleQueue(): Queue | null {
  if (dispatchMode() !== 'queue') return null;
  return new Queue('schedule', { connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) });
}

/**
 * Puente Redis→WS: en modo cola, el worker publica el stream en `exec:*` (Redis pub/sub). Este
 * servicio se suscribe y reinyecta cada evento en el hub, que hace broadcast por WebSocket y
 * proyecta NodeRun — igual que en el modo inline.
 */
@Injectable()
export class RedisEventBridge implements OnModuleInit, OnModuleDestroy {
  private sub?: IORedis;

  constructor(private readonly hub: ExecutionEventHub) {}

  onModuleInit(): void {
    if (dispatchMode() !== 'queue') return;
    this.sub = new IORedis(REDIS_URL);
    void this.sub.psubscribe('exec:*');
    this.sub.on('pmessage', (_pattern, _channel, message) => {
      try {
        void this.hub.publish(JSON.parse(message) as ExecutionEvent);
      } catch {
        /* mensaje inválido: ignorar */
      }
    });
  }

  onModuleDestroy(): void {
    void this.sub?.quit();
  }
}
