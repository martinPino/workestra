import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import type { HyperdriveLike } from './bindings';

/**
 * Cliente Prisma para Cloudflare Workers, conectado a Postgres a través de Hyperdrive.
 *
 * En Workers no existe el binario del query engine de Prisma, así que la conexión la abre `pg` (JS puro
 * sobre el `connect()` de la plataforma) y Prisma habla con él por el driver adapter. La `schema.prisma`
 * y las migraciones NO cambian: sigue siendo el MISMO Postgres que usa Railway hoy, solo cambia el
 * transporte. Eso es lo que permite la convivencia de la fase 3 (los dos backends contra la misma BD).
 *
 * Hyperdrive resuelve el problema de fondo: un Worker se crea y se destruye por petición, así que abrir
 * una conexión TCP a Postgres cada vez agotaría el pool y pagaría el handshake completo en cada request.
 * Hyperdrive mantiene el pool caliente del lado de Cloudflare y le da al Worker una cadena de conexión
 * local.
 */

/**
 * Lo único que el llamante necesita del pool: cerrarlo. Se expone así, y no como el `Pool` de `pg`, para
 * que quien construya el bundle no tenga que depender de `@types/pg` solo por tipar una variable.
 */
export interface PoolLike {
  end(): Promise<void>;
}

export interface HyperdrivePrismaOptions {
  /**
   * Conexiones máximas del pool LOCAL del Worker. Uno, a propósito: cada isolate atiende poca
   * concurrencia y quien agrupa de verdad es Hyperdrive. Subirlo aquí multiplica conexiones por isolate
   * sin ganar nada.
   */
  maxConnections?: number;
}

/**
 * Crea el cliente y el pool. Devuelve ambos porque el pool hay que CERRARLO al terminar la petición
 * (`ctx.waitUntil(pool.end())`): un pool colgado mantiene viva la conexión de un isolate que ya murió.
 */
export function createHyperdrivePrismaClient(
  hyperdrive: HyperdriveLike,
  opts: HyperdrivePrismaOptions = {},
): { prisma: PrismaClient; pool: PoolLike } {
  const pool = new Pool({
    connectionString: hyperdrive.connectionString,
    max: opts.maxConnections ?? 1,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as never);
  return { prisma, pool };
}
