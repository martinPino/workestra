import { z } from 'zod';
import { NodeType, ExecutionStatus, TriggerType } from './enums';

export const PositionSchema = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof PositionSchema>;

/** Nodo del grafo. `key` es único dentro de la WorkflowVersion. */
export const NodeSchema = z.object({
  key: z.string().min(1),
  type: NodeType,
  config: z.record(z.unknown()).default({}),
  position: PositionSchema,
  agentId: z.string().nullish(),
  toolId: z.string().nullish(),
  // M38: paso DESACTIVADO. Al ejecutar, el motor lo salta puenteando sus aristas (el resto del flujo sigue).
  disabled: z.boolean().nullish(),
});
export type WorkflowNode = z.infer<typeof NodeSchema>;

/** Arista dirigida entre nodos (por `key`). `sourceHandle` habilita ramas. */
export const EdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullish(),
  condition: z.record(z.unknown()).nullish(),
});
export type WorkflowEdge = z.infer<typeof EdgeSchema>;

/** Nota/sticky del lienzo (M60): anotación visual del editor. NO afecta a la ejecución (el motor la ignora). */
export const CommentSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  position: PositionSchema,
  color: z.string().nullish(),
  width: z.number().nullish(), // M64: tamaño de la nota (redimensionable arrastrando la esquina)
  height: z.number().nullish(),
});
export type WorkflowComment = z.infer<typeof CommentSchema>;

export const WorkflowGraphSchema = z.object({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  // Notas del lienzo (M60): se PERSISTEN con el grafo pero el motor no las usa. Opcional (grafos previos no las tienen).
  comments: z.array(CommentSchema).optional(),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

/** Servidor MCP externo enganchado a un agente (M40). La URL puede llevar la clave embebida (no hay token aparte). */
export const McpServerRefSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  url: z.string().url(),
});
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().nullish(),
  systemPrompt: z.string(),
  model: z.string(),
  tools: z.array(z.string()).default([]),
  // M40: servidores MCP enganchados a este agente; sus herramientas quedan disponibles al ejecutar.
  mcpServers: z.array(McpServerRefSchema).nullish(),
  memoryScope: z.string().nullish(),
  variables: z.record(z.unknown()).nullish(),
  limits: z.record(z.unknown()).nullish(),
  permissions: z.record(z.unknown()).nullish(),
  isOrchestrator: z.boolean().default(false),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ExecutionSchema = z.object({
  id: z.string(),
  workflowVersionId: z.string(),
  workspaceId: z.string(),
  parentExecutionId: z.string().nullish(),
  status: ExecutionStatus,
  triggerType: TriggerType,
  tokensUsed: z.number().int().default(0),
  costEstimate: z.number().default(0),
  startedAt: z.string().datetime().nullish(),
  finishedAt: z.string().datetime().nullish(),
  /** Instante de creación de la ejecución (siempre presente). Es la «hora» que ve el usuario. */
  createdAt: z.string().datetime().nullish(),
});
export type Execution = z.infer<typeof ExecutionSchema>;

/** Registro append-only del log de ejecución. Fuente para el replay determinista. */
export const ExecutionLogSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  nodeKey: z.string(),
  stepKey: z.string(),
  level: z.string(),
  status: z.string(),
  input: z.record(z.unknown()).nullish(),
  output: z.record(z.unknown()).nullish(),
  prompt: z.record(z.unknown()).nullish(),
  modelResponse: z.record(z.unknown()).nullish(),
  tokens: z.number().int().default(0),
  cost: z.number().default(0),
  durationMs: z.number().int().default(0),
  createdAt: z.string().datetime(),
});
export type ExecutionLog = z.infer<typeof ExecutionLogSchema>;
