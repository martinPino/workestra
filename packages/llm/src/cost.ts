import type { LlmUsage } from '@core/contracts';
import { MODEL_REGISTRY, PRICING_VERSION, type ModelPricing } from './pricing';

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  total: number;
  pricingVersion: string;
}

/** Cálculo de coste REPRODUCIBLE: función pura de (modelo, usage, tabla de precios versionada). */
export class CostCalculator {
  constructor(
    private readonly registry: Record<string, ModelPricing> = MODEL_REGISTRY,
    private readonly version: string = PRICING_VERSION,
  ) {}

  cost(model: string, usage: LlmUsage): CostBreakdown {
    const p = this.registry[model];
    if (!p) return { inputCost: 0, outputCost: 0, total: 0, pricingVersion: this.version };
    const inputCost = round((usage.inputTokens / 1_000_000) * p.inputPer1M);
    const outputCost = round((usage.outputTokens / 1_000_000) * p.outputPer1M);
    return { inputCost, outputCost, total: round(inputCost + outputCost), pricingVersion: this.version };
  }
}

const round = (n: number): number => Math.round(n * 1e8) / 1e8;
