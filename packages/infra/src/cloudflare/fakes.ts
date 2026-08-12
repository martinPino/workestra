import type { DurableObjectNamespaceLike, DurableObjectStubLike, R2BucketLike, R2ObjectLike } from './bindings';

/**
 * Dobles in-memory de los bindings de Cloudflare, para poder testear los adaptadores sin `workerd`.
 *
 * No sustituyen a las pruebas de integración: comprueban el CONTRATO del adaptador (qué clave escribe,
 * qué protocolo habla, cómo trata un 404), no el comportamiento real de R2 ni la serialización de un
 * Durable Object. Lo segundo solo lo verifica un despliegue o `@cloudflare/vitest-pool-workers`.
 */

/** Bucket R2 falso: un Map de clave → objeto, con los metadatos que el adaptador lee. */
export class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string; custom?: Record<string, string> }>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    this.objects.set(key, {
      bytes: toBytes(value),
      contentType: options?.httpMetadata?.contentType,
      custom: options?.customMetadata,
    });
    return undefined;
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      size: o.bytes.byteLength,
      httpMetadata: { contentType: o.contentType },
      customMetadata: o.custom,
      // Copia el rango exacto de la vista, como haría R2 al devolver el cuerpo.
      arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** Normaliza lo que acepta `put` a bytes, respetando el rango de la vista (no el buffer completo). */
function toBytes(value: ArrayBuffer | ArrayBufferView | string): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return new Uint8Array(value.slice(0));
}

/** Respuesta mínima con la forma que consumen los adaptadores. */
function reply(status: number, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async <T>() => JSON.parse(text) as T,
  };
}

/**
 * Namespace de Durable Objects falso. Cada nombre resuelve a un objeto propio con su estado, y el
 * `handler` recibe (ruta, método, cuerpo) — así el test comprueba el aislamiento por id sin montar un DO.
 */
export class FakeDurableObjectNamespace implements DurableObjectNamespaceLike {
  readonly instances = new Map<string, Map<string, unknown>>();

  constructor(
    private readonly handler: (
      state: Map<string, unknown>,
      req: { path: string; search: URLSearchParams; method: string; body: unknown },
    ) => { status: number; body?: unknown },
  ) {}

  idFromName(name: string): unknown {
    if (!this.instances.has(name)) this.instances.set(name, new Map());
    return name;
  }

  get(id: unknown): DurableObjectStubLike {
    const state = this.instances.get(String(id));
    if (!state) throw new Error(`DO inexistente: ${String(id)} (usa idFromName primero)`);
    return {
      fetch: async (input, init) => {
        const url = new URL(input);
        const out = this.handler(state, {
          path: url.pathname,
          search: url.searchParams,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(init.body) : undefined,
        });
        return reply(out.status, out.body);
      },
    };
  }
}
