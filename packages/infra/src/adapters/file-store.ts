import { randomUUID } from 'node:crypto';
import type IORedis from 'ioredis';
import type { IFileStore, FileRef, StoredFile } from '@core/engine';

const DEFAULT_TTL = 172_800; // 48h: los ficheros son efímeros (viven durante la ejecución), como el binario de n8n.

/** Almacén de ficheros in-memory (dev/tests). No comparte entre procesos. */
export class InMemoryFileStore implements IFileStore {
  private readonly files = new Map<string, StoredFile>();

  async put(workspaceId: string, file: StoredFile): Promise<FileRef> {
    const id = randomUUID();
    this.files.set(`${workspaceId}:${id}`, file);
    return { id, name: file.name, mimeType: file.mimeType, size: file.bytes.byteLength };
  }
  async get(workspaceId: string, id: string): Promise<StoredFile | null> {
    return this.files.get(`${workspaceId}:${id}`) ?? null;
  }
}

/**
 * Almacén de ficheros en Redis (compartido por API y worker vía REDIS_URL). Guarda los BYTES como buffer y los
 * metadatos como JSON, ambos con TTL (48h) para que se limpien solos. El contexto de ejecución solo lleva la
 * `FileRef` ligera; los bytes se recuperan bajo demanda por id + workspace (aislado por tenant en la clave).
 */
export class RedisFileStore implements IFileStore {
  constructor(
    private readonly redis: IORedis,
    private readonly ttlSeconds = DEFAULT_TTL,
  ) {}

  private dataKey(ws: string, id: string): string {
    return `file:${ws}:${id}:data`;
  }
  private metaKey(ws: string, id: string): string {
    return `file:${ws}:${id}:meta`;
  }

  async put(workspaceId: string, file: StoredFile): Promise<FileRef> {
    const id = randomUUID();
    const ref: FileRef = { id, name: file.name, mimeType: file.mimeType, size: file.bytes.byteLength };
    await this.redis.set(this.dataKey(workspaceId, id), Buffer.from(file.bytes), 'EX', this.ttlSeconds);
    await this.redis.set(this.metaKey(workspaceId, id), JSON.stringify({ name: ref.name, mimeType: ref.mimeType }), 'EX', this.ttlSeconds);
    return ref;
  }

  async get(workspaceId: string, id: string): Promise<StoredFile | null> {
    const bytes = await this.redis.getBuffer(this.dataKey(workspaceId, id));
    if (!bytes) return null;
    const metaRaw = await this.redis.get(this.metaKey(workspaceId, id));
    let meta: { name?: string; mimeType?: string } = {};
    try {
      meta = metaRaw ? (JSON.parse(metaRaw) as { name?: string; mimeType?: string }) : {};
    } catch {
      meta = {};
    }
    return { name: meta.name ?? 'file', mimeType: meta.mimeType ?? 'application/octet-stream', bytes: new Uint8Array(bytes) };
  }
}
