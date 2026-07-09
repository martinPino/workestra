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

/**
 * Borrador de agente que propone la IA (M68 «crear asistente con IA»). Es la forma canónica del agente
 * (name = rol, description = objetivo, systemPrompt = instrucciones) con valores por defecto tolerantes,
 * para validar la salida del LLM antes de rellenar el formulario que la persona revisa y confirma.
 */
export const AgentDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullish(),
  systemPrompt: z.string().min(1).default('Eres un asistente útil.'),
  model: z.string().default('llama-3.3-70b-versatile'),
  tools: z.array(z.string()).default([]),
  isOrchestrator: z.boolean().default(false),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export const CreateExecutionSchema = z.object({
  workflowId: z.string(),
  triggerType: TriggerType.default('manual'),
  context: ExecutionContextSchema.partial().optional(),
});
export type CreateExecutionDto = z.infer<typeof CreateExecutionSchema>;

/** Registro con email+contraseña (M73). El email se normaliza a minúsculas; la contraseña mínima 8. */
export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200),
  name: z.string().trim().min(1).max(80),
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

/** Inicio de sesión con email+contraseña (M73). */
export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
export type LoginDto = z.infer<typeof LoginSchema>;

/** Roles asignables a un miembro del equipo (M74): OWNER nunca se asigna por API (uno por equipo, en el alta). */
export const AssignableRole = z.enum(['ADMIN', 'EDITOR', 'VIEWER']);

/** Invitar a un miembro al equipo (M74). */
export const InviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: AssignableRole.default('EDITOR'),
});
export type InviteMemberDto = z.infer<typeof InviteMemberSchema>;

/** Actualizar un miembro (M74): cambiar rol y/o cerrar/reabrir su cuenta. Al menos un campo. */
export const UpdateMemberSchema = z
  .object({ role: AssignableRole.optional(), disabled: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.disabled !== undefined, { message: 'Nada que actualizar.' });
export type UpdateMemberDto = z.infer<typeof UpdateMemberSchema>;

/** Aceptar una invitación (M74): el invitado fija su nombre y contraseña. */
export const AcceptInviteSchema = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.').max(200),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;
