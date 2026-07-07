import { describe, it, expect } from 'vitest';
import type { ILlmProvider, LlmRequest, LlmResponse } from '@core/contracts';
import { ModelRouter } from './router';
import { isProviderRateLimited } from './rate-limit';

function fakeProvider(id: string, behavior: (req: LlmRequest) => LlmResponse | never): ILlmProvider {
  return {
    id,
    async chat(req: LlmRequest): Promise<LlmResponse> {
      return behavior(req);
    },
  };
}
const ok = (id: string, model: string): LlmResponse => ({
  content: `${id}:${model}`,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  model,
  providerId: id,
});
const rateLimit = (): never => {
  throw new Error('LLM HTTP 429: Rate limit reached ... tokens per day (TPD)');
};

describe('ModelRouter — fallback entre proveedores (M33)', () => {
  it('isProviderRateLimited detecta 429/cuota y no otros errores', () => {
    expect(isProviderRateLimited(new Error('LLM HTTP 429: ...'))).toBe(true);
    expect(isProviderRateLimited(new Error('Rate limit reached'))).toBe(true);
    expect(isProviderRateLimited(new Error('tokens per day (TPD)'))).toBe(true);
    expect(isProviderRateLimited(new Error('HTTP 500 server error'))).toBe(false);
    expect(isProviderRateLimited(new Error('modelo inválido'))).toBe(false);
  });

  it('cae al siguiente proveedor cuando el primario está agotado, con su modelo', async () => {
    const router = new ModelRouter();
    router.registerProvider(fakeProvider('openai-compatible', rateLimit)); // Groq agotado
    router.registerProvider(fakeProvider('openai', (req) => ok('openai', req.model))); // OpenAI responde
    router.registerProvider(fakeProvider('anthropic', (req) => ok('anthropic', req.model)));
    router.setDefault('openai-compatible');
    router.setFallbackChain([
      { providerId: 'openai-compatible', model: 'llama-3.3-70b-versatile' },
      { providerId: 'openai', model: 'gpt-4o-mini' },
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    ]);

    const res = await router.chat({ model: 'llama-3.3-70b-versatile', messages: [] });
    expect(res.providerId).toBe('openai'); // saltó Groq (agotado) → OpenAI
    expect(res.model).toBe('gpt-4o-mini'); // con el modelo del eslabón OpenAI
  });

  it('encadena hasta Anthropic si Groq y OpenAI están agotados', async () => {
    const router = new ModelRouter();
    router.registerProvider(fakeProvider('openai-compatible', rateLimit));
    router.registerProvider(fakeProvider('openai', rateLimit));
    router.registerProvider(fakeProvider('anthropic', (req) => ok('anthropic', req.model)));
    router.setDefault('openai-compatible');
    router.setFallbackChain([
      { providerId: 'openai-compatible', model: 'llama-3.3-70b-versatile' },
      { providerId: 'openai', model: 'gpt-4o-mini' },
      { providerId: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    ]);
    const res = await router.chat({ model: 'llama-3.3-70b-versatile', messages: [] });
    expect(res.providerId).toBe('anthropic');
  });

  it('un error que NO es rate-limit se lanza sin fallback', async () => {
    const router = new ModelRouter();
    router.registerProvider(fakeProvider('openai-compatible', () => { throw new Error('HTTP 400 bad request'); }));
    router.registerProvider(fakeProvider('openai', (req) => ok('openai', req.model)));
    router.setDefault('openai-compatible');
    router.setFallbackChain([
      { providerId: 'openai-compatible', model: 'llama-3.3-70b-versatile' },
      { providerId: 'openai', model: 'gpt-4o-mini' },
    ]);
    await expect(router.chat({ model: 'llama-3.3-70b-versatile', messages: [] })).rejects.toThrow(/400/);
  });
});
