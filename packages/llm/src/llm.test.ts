import { describe, it, expect } from 'vitest';
import type { ILlmProvider } from '@core/contracts';
import { CostCalculator, PRICING_VERSION, ModelRouter, createLlmRouter, MockLlmProvider } from './index';

describe('CostCalculator (reproducible, precios versionados)', () => {
  it('calcula coste por 1M de tokens con la versión de precios', () => {
    const b = new CostCalculator().cost('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(b.inputCost).toBe(3);
    expect(b.outputCost).toBe(15);
    expect(b.total).toBe(18);
    expect(b.pricingVersion).toBe(PRICING_VERSION);
  });
  it('es reproducible y da 0 para modelos desconocidos', () => {
    const c = new CostCalculator();
    const u = { inputTokens: 1234, outputTokens: 567 };
    expect(c.cost('claude-opus-4-8', u)).toEqual(c.cost('claude-opus-4-8', u));
    expect(c.cost('desconocido', u).total).toBe(0);
  });
});

const fakeProvider = (id: string, tag: string): ILlmProvider => ({
  id,
  async chat(req) {
    return { content: tag, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, model: req.model, providerId: id };
  },
});

describe('ModelRouter — proveedor intercambiable por config', () => {
  it('enruta un modelo a distintos proveedores sin tocar al consumidor', async () => {
    const router = new ModelRouter();
    router.registerProvider(fakeProvider('mock', 'A')).registerProvider(fakeProvider('anthropic', 'B'));
    router.route('m', 'mock');
    expect((await router.chat({ model: 'm', messages: [] })).content).toBe('A');
    router.route('m', 'anthropic'); // solo cambia la config del router
    expect((await router.chat({ model: 'm', messages: [] })).content).toBe('B');
  });
  it('createLlmRouter usa Mock por defecto (sin credenciales)', async () => {
    const r = await createLlmRouter().chat({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hola' }] });
    expect(r.providerId).toBe('mock');
  });
});

describe('MockLlmProvider (determinista para replay)', () => {
  const p = new MockLlmProvider();
  it('mismo input => misma salida', async () => {
    const req = { model: 'mock-1', messages: [{ role: 'user' as const, content: 'hola mundo' }] };
    expect(await p.chat(req)).toEqual(await p.chat(req));
  });
  it('emite tool-call si el prompt lo sugiere y hay tools; luego texto tras el resultado', async () => {
    const tools = [{ name: 'http', description: '', parameters: {} }];
    const first = await p.chat({ model: 'mock-1', messages: [{ role: 'user', content: 'usa http para https://a.com' }], tools });
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0].name).toBe('http');

    const second = await p.chat({
      model: 'mock-1',
      messages: [
        { role: 'user', content: 'usa http' },
        { role: 'tool', name: 'http', content: '{"ok":true}' },
      ],
      tools,
    });
    expect(second.toolCalls).toHaveLength(0);
    expect(second.content).toContain('Mock');
  });
});
