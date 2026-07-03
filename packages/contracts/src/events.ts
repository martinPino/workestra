import { z } from 'zod';
import { ExecutionStatus } from './enums';

/**
 * Contrato de evento de ejecución VERSIONADO (nace en M0/M1 como artefacto de primera clase).
 * Todo emisor debe estampar `schemaVersion`. El reducer determinista (M1) consume este stream
 * para reconstruir el estado y habilitar el replay paso a paso.
 */
export const EXECUTION_EVENT_SCHEMA_VERSION = 1 as const;

const base = z.object({
  schemaVersion: z.literal(EXECUTION_EVENT_SCHEMA_VERSION),
  executionId: z.string(),
  /** ISO-8601. Grabado (no re-derivado) para replay determinista. */
  at: z.string().datetime(),
  /** Secuencia monótona por ejecución. */
  seq: z.number().int().nonnegative(),
});

export const ExecutionEventSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('execution.queued') }),
  base.extend({ type: z.literal('execution.started') }),
  base.extend({ type: z.literal('execution.status'), status: ExecutionStatus }),
  base.extend({ type: z.literal('node.started'), nodeKey: z.string(), stepKey: z.string() }),
  base.extend({
    type: z.literal('node.succeeded'),
    nodeKey: z.string(),
    stepKey: z.string(),
    output: z.unknown().optional(),
  }),
  base.extend({
    type: z.literal('node.failed'),
    nodeKey: z.string(),
    stepKey: z.string(),
    error: z.string(),
  }),
  base.extend({ type: z.literal('execution.succeeded') }),
  base.extend({ type: z.literal('execution.failed'), error: z.string() }),

  // --- Eventos del Orchestrator (sub-DAG dinámico) ---
  base.extend({
    type: z.literal('plan.created'),
    nodeKey: z.string(),
    planId: z.string(),
    subtasks: z.array(z.object({ id: z.string(), agentId: z.string(), task: z.string() })),
    edges: z.array(z.object({ source: z.string(), target: z.string() })),
  }),
  base.extend({ type: z.literal('plan.validation_failed'), nodeKey: z.string(), errors: z.array(z.string()) }),
  base.extend({ type: z.literal('subtask.started'), nodeKey: z.string(), subtaskId: z.string(), agentId: z.string() }),
  base.extend({
    type: z.literal('subtask.succeeded'),
    nodeKey: z.string(),
    subtaskId: z.string(),
    output: z.string(),
  }),
  base.extend({ type: z.literal('subtask.failed'), nodeKey: z.string(), subtaskId: z.string(), error: z.string() }),
  base.extend({ type: z.literal('plan.execution_failed'), nodeKey: z.string(), error: z.string() }),
  base.extend({
    type: z.literal('plan.budget_exceeded'),
    nodeKey: z.string(),
    kind: z.enum(['tokens', 'cost']),
    used: z.number(),
    limit: z.number(),
  }),
  base.extend({ type: z.literal('results.merged'), nodeKey: z.string(), summary: z.string() }),

  // --- Escalado humano (M5) ---
  base.extend({
    type: z.literal('human.requested'),
    nodeKey: z.string(),
    reviewId: z.string(),
    reason: z.string(),
    expiresAt: z.string(),
  }),
  base.extend({
    type: z.literal('human.resolved'),
    nodeKey: z.string(),
    reviewId: z.string(),
    approved: z.boolean(),
    resolvedBy: z.string(),
    decision: z.string(),
  }),
]);

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ExecutionEventType = ExecutionEvent['type'];
