/**
 * Tipos ESTRUCTURALES de los bindings de Cloudflare que usan estos adaptadores.
 *
 * ¿Por qué no `@cloudflare/workers-types`? Porque declara globals (`Request`, `Response`, `fetch`…) que
 * CHOCAN con los de `@types/node`, y este paquete compila con los de Node para los adaptadores de
 * Prisma/Redis. Al tipar solo la superficie que realmente tocamos evitamos el conflicto y dejamos
 * explícito lo poco que el core necesita de la plataforma. El Worker pasa sus bindings reales y encajan
 * por estructura.
 */

/** Objeto devuelto por `R2Bucket.get`: metadatos + acceso a los bytes. */
export interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  size: number;
}

/** Superficie de R2 usada por `R2FileStore`. */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

/** Stub de un Durable Object: se le habla por `fetch` (protocolo interno en `protocol.ts`). */
export interface DurableObjectStubLike {
  fetch(input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
  }>;
}

/** Binding de un namespace de Durable Objects: resuelve un id estable por nombre. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/**
 * Binding de Hyperdrive: expone una cadena de conexión LOCAL al Worker que apunta al pool de Cloudflare,
 * no a la base de datos real. Nunca se registra ni se expone: lleva credenciales.
 */
export interface HyperdriveLike {
  connectionString: string;
}
