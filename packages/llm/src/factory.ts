import { ModelRouter } from './router';
import { MockLlmProvider } from './mock-provider';
import { AnthropicLlmProvider } from './anthropic-provider';
import { OpenAiCompatibleProvider } from './openai-compatible-provider';
import { getModelInfo, MODEL_REGISTRY } from './pricing';

export interface LlmConfig {
  /** Fuerza que TODOS los modelos se sirvan por este proveedor (útil para dev/tests). */
  forceProvider?: 'mock' | 'anthropic' | 'openai-compatible';
  anthropicApiKey?: string;
  /** Endpoint compatible OpenAI (Groq/OpenRouter/Ollama…). Habilita el proveedor por defecto. */
  llmBaseUrl?: string;
  llmApiKey?: string;
  /** Modelo del endpoint compatible que se enruta explícitamente a ese proveedor. */
  llmModel?: string;
}

/**
 * Construye el router a partir de config/env. Cambiar el proveedor de un modelo NO requiere tocar a
 * los consumidores (AgentRuntime): solo la config aquí (criterio T-LLM). Proveedores:
 *   - `anthropic` si hay ANTHROPIC_API_KEY (Claude real).
 *   - `openai-compatible` si hay LLM_BASE_URL (Groq/OpenRouter/Ollama… — gratis/barato); pasa a ser
 *     el proveedor por DEFECTO (los modelos desconocidos van ahí).
 *   - `mock` siempre disponible como último recurso.
 */
export function createLlmRouter(config: LlmConfig = {}): ModelRouter {
  const router = new ModelRouter();
  router.registerProvider(new MockLlmProvider());
  router.setDefault('mock');

  const anthropicKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) router.registerProvider(new AnthropicLlmProvider(anthropicKey));

  const llmBase = config.llmBaseUrl ?? process.env.LLM_BASE_URL;
  const llmModel = config.llmModel ?? process.env.LLM_MODEL;
  if (llmBase) {
    router.registerProvider(new OpenAiCompatibleProvider(llmBase, config.llmApiKey ?? process.env.LLM_API_KEY));
    router.setDefault('openai-compatible'); // modelos desconocidos → endpoint compatible
  }

  if (config.forceProvider) {
    for (const model of Object.keys(MODEL_REGISTRY)) router.route(model, config.forceProvider);
    router.setDefault(config.forceProvider);
    return router;
  }

  // Cada modelo va a su proveedor del registro; si ese proveedor no está registrado (anthropic sin
  // clave, u openai-compatible sin base), el fallback al proveedor por defecto lo cubre.
  for (const model of Object.keys(MODEL_REGISTRY)) router.route(model, getModelInfo(model)!.provider);
  if (llmBase && llmModel) router.route(llmModel, 'openai-compatible');
  return router;
}
