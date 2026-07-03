import type { ILlmProvider, LlmRequest, LlmResponse, LlmToolCall } from '@core/contracts';

interface OpenAiChoice {
  message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
}
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function safeParse(s: string | undefined): Record<string, unknown> {
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Proveedor compatible con la API de OpenAI (`/chat/completions`). Sirve para conectar CUALQUIER
 * endpoint compatible sin pagar créditos caros de Anthropic: Groq (free tier), OpenRouter (modelos
 * `:free`), Ollama / LM Studio (locales, gratis), Together, etc. Se configura por env:
 *   LLM_BASE_URL  (p. ej. https://api.groq.com/openai/v1)
 *   LLM_API_KEY   (opcional: Ollama local no la necesita)
 *   LLM_MODEL     (el modelo a usar por defecto)
 */
export class OpenAiCompatibleProvider implements ILlmProvider {
  readonly id = 'openai-compatible';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const messages = req.messages.map((m) => ({
      // Muchos endpoints compatibles no soportan role:'tool'; lo degradamos a 'user' con prefijo.
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.role === 'tool' ? `[tool:${m.name}] ${m.content}` : m.content,
    }));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens ?? 1024,
    };
    if (req.responseFormat === 'json') body['response_format'] = { type: 'json_object' };
    if (req.tools?.length) {
      body['tools'] = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as OpenAiResponse;

    const msg = data.choices?.[0]?.message ?? {};
    const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      arguments: safeParse(tc.function?.arguments),
    }));

    return {
      content: msg.content ?? '',
      toolCalls,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      model: req.model,
      providerId: this.id,
    };
  }
}
