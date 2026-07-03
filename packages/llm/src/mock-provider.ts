import type { ILlmProvider, LlmRequest, LlmResponse, LlmToolCall, LlmToolDef } from '@core/contracts';

const tokenize = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"']+/)?.[0];
}

function deterministicArgs(tool: LlmToolDef, prompt: string): Record<string, unknown> {
  if (tool.name === 'http') {
    return { method: 'GET', url: extractUrl(prompt) ?? 'https://example.com' };
  }
  return { input: truncate(prompt, 80) };
}

/**
 * Proveedor LLM DETERMINISTA para tests/replay (sin red, sin `Date`/random). Si hay tools
 * disponibles y el prompt sugiere usarlas, emite una tool-call en la primera vuelta; en la
 * segunda (ya con resultado de tool) devuelve una respuesta de texto. Cuenta tokens por palabras.
 */
export class MockLlmProvider implements ILlmProvider {
  readonly id = 'mock';

  async chat(req: LlmRequest): Promise<LlmResponse> {
    // Salida estructurada de PLAN (Orchestrator): construye un plan determinista fan-out.
    if (req.responseFormat === 'json') {
      const combined = req.messages.map((m) => m.content).join('\n');
      const agentsMatch = combined.match(/<<PLAN_AGENTS:([^>]*)>>/);
      const taskMatch = combined.match(/<<PLAN_TASK:([^>]*)>>/);
      if (agentsMatch) {
        const ids = agentsMatch[1].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
        const task = (taskMatch?.[1] ?? 'la tarea').trim();
        const subtasks = ids.map((id, i) => ({ id: `st${i + 1}`, agentId: id, task: `Subtarea ${i + 1}: ${truncate(task, 60)}` }));
        const edges = subtasks.slice(1).map((s) => ({ source: 'st1', target: s.id })); // fan-out desde st1
        const content = JSON.stringify({ subtasks, edges });
        return { content, toolCalls: [], usage: { inputTokens: tokenize(combined), outputTokens: tokenize(content) }, model: req.model, providerId: this.id };
      }
    }

    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUser?.content ?? '';
    const hasToolResult = req.messages.some((m) => m.role === 'tool');

    const toolCalls: LlmToolCall[] = [];
    if (req.tools && req.tools.length > 0 && !hasToolResult && /\b(usa|use|call|invoca|http|fetch|tool)\b/i.test(prompt)) {
      const tool = req.tools[0];
      toolCalls.push({ id: `call_${tool.name}`, name: tool.name, arguments: deterministicArgs(tool, prompt) });
    }

    const content = toolCalls.length > 0 ? '' : `Mock: respuesta determinista a "${truncate(prompt, 120)}".`;
    const inputTokens = tokenize(req.messages.map((m) => m.content).join(' '));
    const outputTokens = tokenize(content) + toolCalls.length * 8;

    return { content, toolCalls, usage: { inputTokens, outputTokens }, model: req.model, providerId: this.id };
  }
}
