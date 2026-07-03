/** Registro de modelos y precios VERSIONADOS (para un CostCalculator reproducible). */

export interface ModelPricing {
  model: string;
  provider: string;
  /** USD por 1M de tokens. */
  inputPer1M: number;
  outputPer1M: number;
  contextWindow: number;
}

export const PRICING_VERSION = '2026-01-01';

export const MODEL_REGISTRY: Record<string, ModelPricing> = {
  'claude-opus-4-8': { model: 'claude-opus-4-8', provider: 'anthropic', inputPer1M: 15, outputPer1M: 75, contextWindow: 200_000 },
  'claude-sonnet-5': { model: 'claude-sonnet-5', provider: 'anthropic', inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 },
  'claude-haiku-4-5': { model: 'claude-haiku-4-5', provider: 'anthropic', inputPer1M: 0.8, outputPer1M: 4, contextWindow: 200_000 },
  'gpt-5': { model: 'gpt-5', provider: 'openai', inputPer1M: 10, outputPer1M: 30, contextWindow: 128_000 },
  'mock-1': { model: 'mock-1', provider: 'mock', inputPer1M: 0.5, outputPer1M: 1.5, contextWindow: 8_192 },
};

export function getModelInfo(model: string): ModelPricing | undefined {
  return MODEL_REGISTRY[model];
}
