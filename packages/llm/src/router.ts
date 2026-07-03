import type { ILlmProvider, LlmRequest, LlmResponse } from '@core/contracts';
import { getModelInfo } from './pricing';

/**
 * Enruta cada modelo a un proveedor. El consumidor (AgentRuntime) solo llama a `chat`; cambiar
 * qué proveedor sirve un modelo (por config) no toca al consumidor — criterio de aceptación T-LLM.
 */
export class ModelRouter {
  private readonly providers = new Map<string, ILlmProvider>();
  private readonly overrides = new Map<string, string>(); // model -> providerId

  registerProvider(provider: ILlmProvider): this {
    this.providers.set(provider.id, provider);
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
    if (!provider) {
      throw new Error(`No hay proveedor LLM registrado para el modelo "${model}" (proveedor ${providerId ?? 'desconocido'}).`);
    }
    return provider;
  }

  chat(req: LlmRequest): Promise<LlmResponse> {
    return this.providerFor(req.model).chat(req);
  }
}
