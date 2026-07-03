import { z } from 'zod';

/**
 * Contexto que fluye por el DAG. Cada nodo lo recibe, lo modifica y lo pasa al siguiente.
 * `passthrough` permite claves adicionales sin romper el contrato.
 */
export const ExecutionContextSchema = z
  .object({
    ticket: z.record(z.unknown()).default({}),
    repository: z.record(z.unknown()).default({}),
    memory: z.record(z.unknown()).default({}),
    variables: z.record(z.unknown()).default({}),
  })
  .passthrough();

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

export const emptyContext = (): ExecutionContext =>
  ExecutionContextSchema.parse({});
