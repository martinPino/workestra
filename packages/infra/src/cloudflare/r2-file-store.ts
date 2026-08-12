import type { IFileStore, FileRef, StoredFile } from '@core/engine';
import type { R2BucketLike } from './bindings';

/**
 * Almacén de ficheros en R2 (sustituye a `RedisFileStore`, M48). Los bytes viven fuera del contexto de
 * ejecución —que es JSON y se persiste— y el contexto solo lleva la `FileRef` ligera; los bytes se
 * recuperan bajo demanda por id + workspace. El aislamiento por tenant va en la clave, igual que en Redis.
 *
 * GOTCHA DE DESPLIEGUE: el TTL de 48 h deja de estar en el código y pasa a ser una LIFECYCLE RULE del
 * bucket. Redis expiraba las claves solo; R2 no borra nada si nadie se lo dice. Sin la regla, cada PDF
 * que pase por un workflow se queda en el bucket para siempre — no se rompe nada, pero la factura crece
 * en silencio. La regla se crea una vez al provisionar el bucket:
 *
 *     wrangler r2 bucket lifecycle add workestra-files --prefix file/ --expire-days 2
 */
export class R2FileStore implements IFileStore {
  constructor(private readonly bucket: R2BucketLike) {}

  /** Prefijo `file/` para que la lifecycle rule pueda acotar por prefijo sin tocar otros objetos. */
  private key(workspaceId: string, id: string): string {
    return `file/${workspaceId}/${id}`;
  }

  async put(workspaceId: string, file: StoredFile): Promise<FileRef> {
    const id = crypto.randomUUID();
    // Se pasa la VISTA (`Uint8Array`), no `bytes.buffer`: un Uint8Array puede ser una vista sobre un
    // buffer mayor (p. ej. al trocear una descarga), y R2 respeta el byteOffset/byteLength de la vista
    // mientras que el buffer subyacente subiría bytes de más.
    await this.bucket.put(this.key(workspaceId, id), file.bytes, {
      httpMetadata: { contentType: file.mimeType },
      // El nombre va en metadatos, no en la clave: puede llevar cualquier carácter y la clave debe ser opaca.
      customMetadata: { name: file.name },
    });
    return { id, name: file.name, mimeType: file.mimeType, size: file.bytes.byteLength };
  }

  async get(workspaceId: string, id: string): Promise<StoredFile | null> {
    const obj = await this.bucket.get(this.key(workspaceId, id));
    // null = no existe O ya caducó por lifecycle. Indistinguibles, y el llamante trata ambos igual.
    if (!obj) return null;
    return {
      name: obj.customMetadata?.name ?? id,
      mimeType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      bytes: new Uint8Array(await obj.arrayBuffer()),
    };
  }
}
