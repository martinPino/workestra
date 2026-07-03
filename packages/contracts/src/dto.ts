import { z } from 'zod';
import { WorkflowGraphSchema, AgentSchema } from './entities';
import { ExecutionContextSchema } from './context';
import { TriggerType } from './enums';

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  graph: WorkflowGraphSchema.optional(),
});
export type CreateWorkflowDto = z.infer<typeof CreateWorkflowSchema>;

export const CreateAgentSchema = AgentSchema.omit({ id: true });
export type CreateAgentDto = z.infer<typeof CreateAgentSchema>;

export const CreateExecutionSchema = z.object({
  workflowId: z.string(),
  triggerType: TriggerType.default('manual'),
  context: ExecutionContextSchema.partial().optional(),
});
export type CreateExecutionDto = z.infer<typeof CreateExecutionSchema>;
