import { z } from 'zod';

/** Los tipos de nodo del editor visual. Añadir uno nuevo se hace por plugin/registro. */
export const NodeType = z.enum([
  'trigger',
  'agent',
  'condition',
  'loop',
  'wait',
  'tool',
  'api',
  'llm',
  'code',
  'download',
  'extract',
  'memory',
  'human',
  'connector',
  'router',
  'end',
]);
export type NodeType = z.infer<typeof NodeType>;

export const Role = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
export type Role = z.infer<typeof Role>;

export const WorkflowStatus = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export const ExecutionStatus = z.enum([
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'WAITING_HUMAN',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const TriggerType = z.enum([
  'manual',
  'webhook',
  'cron',
  'api',
  'issue.created',
  'issue.updated',
  'pr.opened',
  'pr.merged',
  'commit',
]);
export type TriggerType = z.infer<typeof TriggerType>;
