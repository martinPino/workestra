import type { ILlmProvider, LlmRequest, LlmResponse, LlmToolCall } from '@core/contracts';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface AnthropicResponse {
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Adaptador REAL de Anthropic (Messages API). Solo se usa si `ANTHROPIC_API_KEY` está configurada;
 * en dev/tests el proveedor por defecto es el Mock. Mapeo simplificado (M3); el round-trip completo
 * de tool_use/tool_result se endurece en fases posteriores.
 */
export class AnthropicLlmProvider implements ILlmProvider {
  readonly id = 'anthropic';

  constructor(
    private readonly apiKey: string = process.env.ANTHROPIC_API_KEY ?? '',
    private readonly baseUrl: string = 'https://api.anthropic.com',
  ) {}

  async chat(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');

    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.role === 'tool' ? `[tool:${m.name}] ${m.content}` : m.content,
      }));

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature,
        system: system || undefined,
        messages,
        tools: req.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
    });

    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as AnthropicResponse;

    const content = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const toolCalls: LlmToolCall[] = (data.content ?? [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id ?? '', name: b.name ?? '', arguments: b.input ?? {} }));

    return {
      content,
      toolCalls,
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
      model: req.model,
      providerId: this.id,
    };
  }
}
