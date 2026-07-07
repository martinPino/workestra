import type { ILlmProvider, LlmRequest, LlmResponse } from '@core/contracts';
import { getModelInfo } from './pricing';
import { isProviderRateLimited } from './rate-limit';

/** Un eslabón de la cadena de fallback: qué proveedor probar y con qué modelo. */
export interface FallbackEntry {
  providerId: string;
  model: string;
}

/**
 * Enruta cada modelo a un proveedor. El consumidor (AgentRuntime) solo llama a `chat`; cambiar
 * qué proveedor sirve un modelo (por config) no toca al consumidor — criterio de aceptación T-LLM.
 *
 * Fallback entre proveedores (M33): si el proveedor primario se agota (429/cuota), `chat` cae al
 * siguiente proveedor de la cadena con SU modelo por defecto (p. ej. Groq→OpenAI→Anthropic).
 */
export class ModelRouter {
  private readonly providers = new Map<string, ILlmProvider>();
  private readonly overrides = new Map<string, string>(); // model -> providerId
  private defaultProviderId?: string;
  private fallbackChain: FallbackEntry[] = [];

  registerProvider(provider: ILlmProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  /** Fija la cadena de fallback (orden de proveedores a probar cuando el primario se agota). */
  setFallbackChain(chain: FallbackEntry[]): this {
    this.fallbackChain = chain;
    return this;
  }

  /** Proveedor por defecto para modelos sin override ni entrada en el registro (p. ej. Groq/Ollama). */
  setDefault(providerId: string): this {
    this.defaultProviderId = providerId;
    return this;
  }

  /** Fuerza un modelo a un proveedor concreto (override sobre el proveedor por defecto del modelo). */
  route(model: string, providerId: string): this {
    this.overrides.set(model, providerId);
    return this;
  }

  /** Infiere el proveedor por el prefijo del modelo cuando no está en el registro (claude*→anthropic,
   *  gpt-4/gpt-5/o1/o3→openai). NO cubre «openai/gpt-oss-*» (a propósito: eso lo sirve Groq/OpenRouter). */
  private inferProviderId(model: string): string | undefined {
    if (/^claude/i.test(model)) return 'anthropic';
    if (/^(gpt-[45]|gpt-3|o[13][-.])/i.test(model)) return 'openai';
    return undefined;
  }

  providerFor(model: string): ILlmProvider {
    const providerId = this.overrides.get(model) ?? getModelInfo(model)?.provider ?? this.inferProviderId(model);
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (provider) return provider;
    // Fallback: si el proveedor resuelto no está registrado (p. ej. anthropic sin clave) o el modelo
    // es desconocido, usa el proveedor por defecto (openai-compatible o mock).
    const fallback = this.defaultProviderId ? this.providers.get(this.defaultProviderId) : undefined;
    if (fallback) return fallback;
    throw new Error(`No hay proveedor LLM registrado para el modelo "${model}" (proveedor ${providerId ?? 'desconocido'}).`);
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const primary = this.providerFor(req.model);
    // Cadena de intentos: primero el proveedor del modelo pedido (con su modelo), luego el resto de la
    // cadena de fallback (cada uno con su modelo por defecto), saltando el primario para no repetirlo.
    const attempts: Array<{ provider: ILlmProvider; model: string }> = [{ provider: primary, model: req.model }];
    for (const entry of this.fallbackChain) {
      const provider = this.providers.get(entry.providerId);
      if (provider && provider.id !== primary.id) attempts.push({ provider, model: entry.model });
    }

    let lastErr: unknown;
    for (const { provider, model } of attempts) {
      try {
        return await provider.chat({ ...req, model });
      } catch (e) {
        // Solo se cae al siguiente proveedor si el actual está AGOTADO (429/cuota); otros errores se lanzan.
        if (!isProviderRateLimited(e)) throw e;
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('No hay proveedores LLM disponibles.');
  }
}
