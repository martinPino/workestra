import type { ILlmProvider, LlmRequest, LlmResponse } from '@core/contracts';
import { getModelInfo } from './pricing';

/**
 * Enruta cada modelo a un proveedor. El consumidor (AgentRuntime) solo llama a `chat`; cambiar
 * qué proveedor sirve un modelo (por config) no toca al consumidor — criterio de aceptación T-LLM.
 */
export class ModelRouter {
  private readonly providers = new Map<string, ILlmProvider>();
  private readonly overrides = new Map<string, string>(); // model -> providerId
  private defaultProviderId?: string;

  registerProvider(provider: ILlmProvider): this {
    this.providers.set(provider.id, provider);
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

  providerFor(model: string): ILlmProvider {
    const providerId = this.overrides.get(model) ?? getModelInfo(model)?.provider;
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (provider) return provider;
    // Fallback: si el proveedor resuelto no está registrado (p. ej. anthropic sin clave) o el modelo
    // es desconocido, usa el proveedor por defecto (openai-compatible o mock).
    const fallback = this.defaultProviderId ? this.providers.get(this.defaultProviderId) : undefined;
    if (fallback) return fallback;
    throw new Error(`No hay proveedor LLM registrado para el modelo "${model}" (proveedor ${providerId ?? 'desconocido'}).`);
  }

  chat(req: LlmRequest): Promise<LlmResponse> {
    return this.providerFor(req.model).chat(req);
  }
}
