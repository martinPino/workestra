/** Contratos de la capa LLM: mensajes, tool-calling y el puerto ILlmProvider. */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Presente en mensajes role:'tool' — id de la tool-call a la que responde. */
  toolCallId?: string;
  /** Nombre de la tool (mensajes role:'tool'). */
  name?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema de los argumentos. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** Fuerza salida estructurada (usado por el Planner del Orchestrator). */
  responseFormat?: 'text' | 'json';
}

export interface LlmResponse {
  content: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  model: string;
  providerId: string;
}

/** Puerto de proveedor LLM. Se cambia por config sin tocar a los consumidores (agentes). */
export interface ILlmProvider {
  readonly id: string;
  chat(req: LlmRequest): Promise<LlmResponse>;
}
