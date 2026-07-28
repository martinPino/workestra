import { z } from 'zod';
import { WorkflowGraphSchema } from './entities';

/**
 * Compartir un workflow por enlace (M85).
 *
 * Un workflow NO viaja solo: referencia agentes y conectores POR ID (que no existen en otro espacio) y
 * arrastra secretos —una clave de API en las cabeceras de un nodo, el id de una hoja de cálculo, el token
 * embebido en la URL de un MCP—. Compartir el grafo tal cual sería filtrar esos secretos a cualquiera con
 * el enlace.
 *
 * Por eso lo que se comparte es una forma PORTABLE y SANITIZADA: la estructura y las instrucciones (para que
 * sirva de verdad, como una plantilla), con los secretos fuera y las referencias convertidas en marcadores
 * que quien importe rellena con lo suyo. Reusa los mismos marcadores que el marketplace (`agentRef`,
 * `provider`), así el importador es el que ya existe.
 */

export const SHARE_DOC_VERSION = 1;

/** Un agente en su forma portable: su definición, sin id de espacio. `ref` lo enlaza con el nodo del grafo. */
export const PortableAgentSchema = z
  .object({
    ref: z.string(),
    name: z.string(),
    role: z.string().optional(),
    systemPrompt: z.string(),
    model: z.string(),
    tools: z.array(z.string()).default([]),
    /** MCP: solo el nombre. La URL se quita —puede llevar la clave embebida— y la pone quien importe. */
    mcpServers: z.array(z.object({ name: z.string() })).optional(),
    isOrchestrator: z.boolean().optional(),
  })
  .strict();
export type PortableAgent = z.infer<typeof PortableAgentSchema>;

/** El workflow compartido: el grafo (con marcadores dentro de la config de los nodos) + sus agentes. */
export const PortableWorkflowDocSchema = z
  .object({
    version: z.literal(SHARE_DOC_VERSION),
    name: z.string(),
    graph: WorkflowGraphSchema,
    agents: z.array(PortableAgentSchema),
  })
  .strict();
export type PortableWorkflowDoc = z.infer<typeof PortableWorkflowDocSchema>;

/** Algo ESTRUCTURAL que se quitó (una referencia o un id de cuenta): quien importe tendrá que ponerlo. */
export const ShareStripItemSchema = z
  .object({
    kind: z.enum(['connectorId', 'accountId', 'folderId', 'mcpServer', 'header', 'urlKey', 'toolId']),
    node: z.string().optional(),
    agent: z.string().optional(),
    provider: z.string().optional(),
  })
  .strict();
export type ShareStripItem = z.infer<typeof ShareStripItemSchema>;

/** Algo que PARECÍA un secreto dentro de un texto (un prompt, un cuerpo): redactado, o pendiente de revisar. */
export const ShareRedactionItemSchema = z
  .object({
    location: z.string(),
    /** Etiqueta de qué forma tenía (p. ej. «clave de API»), nunca el valor. */
    pattern: z.string(),
    action: z.enum(['redact', 'needs_review']),
  })
  .strict();
export type ShareRedactionItem = z.infer<typeof ShareRedactionItemSchema>;

/**
 * Lo que se le enseña a quien comparte ANTES de crear el enlace: qué viaja, qué se quita y qué se redacta.
 * Se congela junto al share para que quien importe vea también en qué estado llegó.
 */
export const ShareReportSchema = z
  .object({
    willShare: z.object({
      nodeCount: z.number(),
      agentCount: z.number(),
      /** Los prompts viajan tal cual: se avisa para que quien comparte revise si hay datos privados. */
      promptChars: z.number(),
    }),
    structuralStrip: z.array(ShareStripItemSchema),
    contentRedactions: z.array(ShareRedactionItemSchema),
    /** Sospechas de secreto de BAJA confianza: no se comparte hasta que se arregle o se acepte a conciencia. */
    blocking: z.array(ShareRedactionItemSchema),
    redactionCount: z.number(),
    canCreate: z.boolean(),
  })
  .strict();
export type ShareReport = z.infer<typeof ShareReportSchema>;

/** Petición de compartir. `dryRun` (por defecto) solo devuelve el informe, sin crear nada. */
export const CreateShareRequestSchema = z
  .object({
    dryRun: z.boolean().default(true),
    /** Ubicaciones de items de bajo nivel de confianza que quien comparte acepta compartir a conciencia. */
    acknowledgeBlocking: z.array(z.string()).optional(),
    expiresInDays: z.number().int().positive().nullable().optional(),
  })
  .strict();
export type CreateShareRequest = z.infer<typeof CreateShareRequestSchema>;

export const CreateShareResponseSchema = z.object({
  report: ShareReportSchema,
  token: z.string().optional(),
  url: z.string().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreateShareResponse = z.infer<typeof CreateShareResponseSchema>;

/** Lo que devuelve la lectura PÚBLICA del enlace: el workflow ya sanitizado + el informe. */
export const SharePreviewResponseSchema = z.object({
  name: z.string(),
  doc: PortableWorkflowDocSchema,
  report: ShareReportSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
});
export type SharePreviewResponse = z.infer<typeof SharePreviewResponseSchema>;
