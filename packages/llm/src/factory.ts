import { ModelRouter } from './router';
import { MockLlmProvider } from './mock-provider';
import { AnthropicLlmProvider } from './anthropic-provider';
import { getModelInfo, MODEL_REGISTRY } from './pricing';

export interface LlmConfig {
  /** Fuerza que TODOS los modelos se sirvan por este proveedor (útil para dev/tests). */
  forceProvider?: 'mock' | 'anthropic';
  anthropicApiKey?: string;
}

/**
 * Construye el router a partir de config. Cambiar el proveedor de un modelo NO requiere tocar a
 * los consumidores (AgentRuntime): solo cambia la config aquí (criterio de aceptación T-LLM).
 */
export function createLlmRouter(config: LlmConfig = {}): ModelRouter {
  const router = new ModelRouter();
  router.registerProvider(new MockLlmProvider());

  const apiKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) router.registerProvider(new AnthropicLlmProvider(apiKey));

  const models = Object.keys(MODEL_REGISTRY);
  const forced = !apiKey || config.forceProvider === 'mock' ? 'mock' : config.forceProvider;

  for (const model of models) {
    if (forced) router.route(model, forced);
    // Sin forzar y con clave: modelos anthropic → anthropic; el resto (gpt/mock) → mock.
    else router.route(model, getModelInfo(model)?.provider === 'anthropic' ? 'anthropic' : 'mock');
  }
  return router;
}
