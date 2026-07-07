import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ISecretStore } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';

/** Proveedores para los que un workspace puede aportar SU propia clave (BYOK, M35). */
export const BYOK_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'groq'] as const;
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

/** Claves del workspace resueltas (texto claro) para construir su router. Interno: NUNCA se expone por API. */
export interface ResolvedByok {
  openai?: string;
  anthropic?: string;
  openrouter?: string;
  groq?: string;
}

const secretKey = (provider: string): string => `byok:llm:${provider}`;

/**
 * Claves de IA propias por workspace (BYOK, M35). Se guardan CIFRADAS en el ISecretStore (AES-GCM), una por
 * proveedor. Cuando un workspace tiene su clave, sus peticiones de IA usan ESA (sobrescribe la de plataforma).
 */
@Injectable()
export class LlmKeysService {
  private readonly secrets: ISecretStore;
  constructor(@Inject(PERSISTENCE) p: PersistenceBundle) {
    this.secrets = p.secrets;
  }

  /** Lista qué proveedores tienen clave propia (enmascarada: solo los últimos 4). Nunca la clave completa. */
  async list(workspaceId: string): Promise<Array<{ provider: ByokProvider; last4: string }>> {
    const out: Array<{ provider: ByokProvider; last4: string }> = [];
    for (const provider of BYOK_PROVIDERS) {
      const v = await this.secrets.get(workspaceId, secretKey(provider));
      if (v) out.push({ provider, last4: v.slice(-4) });
    }
    return out;
  }

  async set(workspaceId: string, provider: string, apiKey: string): Promise<{ provider: ByokProvider; last4: string }> {
    if (!BYOK_PROVIDERS.includes(provider as ByokProvider)) {
      throw new BadRequestException(`Proveedor no soportado: ${provider}. Válidos: ${BYOK_PROVIDERS.join(', ')}.`);
    }
    const key = (apiKey ?? '').trim();
    if (key.length < 8) throw new BadRequestException('La clave de API parece incompleta.');
    await this.secrets.set(workspaceId, secretKey(provider), key);
    return { provider: provider as ByokProvider, last4: key.slice(-4) };
  }

  async remove(workspaceId: string, provider: string): Promise<{ removed: boolean }> {
    if (!BYOK_PROVIDERS.includes(provider as ByokProvider)) return { removed: false };
    await this.secrets.delete(workspaceId, secretKey(provider));
    return { removed: true };
  }

  /** Resuelve las claves en claro del workspace (uso interno para construir su router). */
  async resolve(workspaceId: string): Promise<ResolvedByok> {
    const [openai, anthropic, openrouter, groq] = await Promise.all(
      BYOK_PROVIDERS.map((p) => this.secrets.get(workspaceId, secretKey(p))),
    );
    return {
      openai: openai ?? undefined,
      anthropic: anthropic ?? undefined,
      openrouter: openrouter ?? undefined,
      groq: groq ?? undefined,
    };
  }
}
