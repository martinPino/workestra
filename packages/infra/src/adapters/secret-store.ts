import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ISecretStore } from '@core/engine';

/**
 * Cifrado de sobre AES-256-GCM para secretos en reposo (M7). La clave maestra viene de
 * `KMS_MASTER_KEY` (nombre canónico de `.env.example`; se acepta `SECRETS_MASTER_KEY` como alias):
 * hex de 64 chars, base64 de 32 bytes, o una passphrase (derivada con SHA-256). Formato de
 * ciphertext: `v1:<iv_b64>:<tag_b64>:<ct_b64>`, autenticado (GCM detecta manipulación).
 *
 * FAIL-CLOSED en producción: si no hay clave y `NODE_ENV=production`, LANZA en vez de caer en una
 * clave de desarrollo derivada de una cadena pública (que permitiría descifrar todos los secretos).
 */
export class EnvelopeCrypto {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(masterKey?: string) {
    const provided = masterKey ?? process.env.KMS_MASTER_KEY ?? process.env.SECRETS_MASTER_KEY;
    if (provided) {
      this.key = EnvelopeCrypto.deriveKey(provided);
      this.keyId = 'kms';
      return;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('KMS_MASTER_KEY es obligatorio en producción: sin él los secretos se cifrarían con una clave de desarrollo pública.');
    }

    console.warn('[secrets] KMS_MASTER_KEY no definido: usando clave de DESARROLLO derivada (NO válida en producción).');
    this.key = createHash('sha256').update('agentflow-dev-secrets-key').digest();
    this.keyId = 'dev';
  }

  /**
   * Deriva una clave de 32 bytes SIN ambigüedad de codificación: (1) hex de 64 chars → 32 bytes;
   * (2) base64 que round-trip a EXACTAMENTE 32 bytes; (3) en otro caso, passphrase → SHA-256. El
   * orden hex→base64 evita que un hex de 64 chars (que también encaja como base64) se malinterprete.
   */
  private static deriveKey(material: string): Buffer {
    if (/^[0-9a-fA-F]{64}$/.test(material)) return Buffer.from(material, 'hex');
    const b64 = Buffer.from(material, 'base64');
    if (b64.length === 32 && b64.toString('base64').replace(/=+$/, '') === material.replace(/=+$/, '')) return b64;
    return createHash('sha256').update(material).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [v, ivB64, tagB64, ctB64] = payload.split(':');
    if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Ciphertext de secreto con formato inválido.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Secret store in-memory (dev/tests) — cifrado en reposo igual que el durable. */
export class InMemorySecretStore implements ISecretStore {
  private readonly byWs = new Map<string, Map<string, string>>();
  constructor(private readonly crypto = new EnvelopeCrypto()) {}

  async set(workspaceId: string, key: string, plaintext: string): Promise<void> {
    const ws = this.byWs.get(workspaceId) ?? new Map<string, string>();
    ws.set(key, this.crypto.encrypt(plaintext));
    this.byWs.set(workspaceId, ws);
  }

  async get(workspaceId: string, key: string): Promise<string | null> {
    const enc = this.byWs.get(workspaceId)?.get(key);
    return enc ? this.crypto.decrypt(enc) : null;
  }

  async list(workspaceId: string): Promise<string[]> {
    return [...(this.byWs.get(workspaceId)?.keys() ?? [])].sort();
  }

  async delete(workspaceId: string, key: string): Promise<void> {
    this.byWs.get(workspaceId)?.delete(key);
  }
}

/** Secret store durable (Prisma) — mapea el modelo `Secret` (ciphertext cifrado, unique (ws,key)). */
export class PrismaSecretStore implements ISecretStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly crypto = new EnvelopeCrypto(),
  ) {}

  async set(workspaceId: string, key: string, plaintext: string): Promise<void> {
    const ciphertext = this.crypto.encrypt(plaintext);
    await this.prisma.secret.upsert({
      where: { workspaceId_key: { workspaceId, key } },
      create: { workspaceId, key, ciphertext, kmsKeyId: this.crypto.keyId },
      update: { ciphertext, kmsKeyId: this.crypto.keyId, version: { increment: 1 } },
    });
  }

  async get(workspaceId: string, key: string): Promise<string | null> {
    const row = await this.prisma.secret.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    return row ? this.crypto.decrypt(row.ciphertext) : null;
  }

  async list(workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.secret.findMany({ where: { workspaceId }, select: { key: true }, orderBy: { key: 'asc' } });
    return rows.map((r) => r.key);
  }

  async delete(workspaceId: string, key: string): Promise<void> {
    await this.prisma.secret.deleteMany({ where: { workspaceId, key } });
  }
}
