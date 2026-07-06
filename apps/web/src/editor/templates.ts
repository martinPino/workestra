import type { GraphDoc } from './model';

/**
 * Plantillas de flujo por caso de uso (M23): el primer contacto NO es un lienzo en blanco. Cada plantilla
 * es un grafo YA CABLEADO y auto-contenido (sin agentes/conectores previos), que el usuario clona y ajusta.
 * Los nodos LLM leen `{{ticket.*}}` del disparador (siempre seguro); nada depende de datos de otro workspace.
 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  doc: GraphDoc;
}

type N = GraphDoc['nodes'][number];
const node = (id: string, kind: string, x: number, y: number, config: Record<string, unknown> = {}): N =>
  ({ id, kind, position: { x, y }, config }) as N;
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `e_${source}_${target}${sourceHandle ? `_${sourceHandle}` : ''}`, source, target, sourceHandle: sourceHandle ?? null });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'summarize',
    name: 'Resumir un texto con IA',
    description: 'Recibe un texto y devuelve un resumen breve y claro.',
    icon: '📝',
    category: 'Productividad',
    doc: {
      nodes: [
        node('trigger', 'trigger', 40, 160, { event: 'manual' }),
        node('ai', 'llm', 300, 160, { model: 'mock-1', prompt: 'Eres un asistente que resume en 3 frases claras.', input: 'Resume esto:\n{{ticket.summary}}' }),
        node('end', 'end', 560, 160, {}),
      ],
      edges: [edge('trigger', 'ai'), edge('ai', 'end')],
      comments: [],
    },
  },
  {
    id: 'reply',
    name: 'Redactar una respuesta',
    description: 'Escribe una respuesta educada a un mensaje entrante.',
    icon: '💬',
    category: 'Atención al cliente',
    doc: {
      nodes: [
        node('trigger', 'trigger', 40, 160, { event: 'manual' }),
        node('ai', 'llm', 300, 160, { model: 'mock-1', prompt: 'Eres un agente de soporte. Responde con amabilidad y de forma útil.', input: 'Responde a este mensaje:\n{{ticket.summary}}' }),
        node('end', 'end', 560, 160, {}),
      ],
      edges: [edge('trigger', 'ai'), edge('ai', 'end')],
      comments: [],
    },
  },
  {
    id: 'jira-triage',
    name: 'Avisar cuando entra un ticket',
    description: 'Cuando llega un ticket de una app conectada, lo resume y lo anota. Buen punto de partida para Jira.',
    icon: '🎫',
    category: 'Ops',
    doc: {
      nodes: [
        node('trigger', 'trigger', 40, 160, { event: 'webhook' }),
        node('ai', 'llm', 300, 160, { model: 'mock-1', prompt: 'Resume el ticket en una frase y sugiere quién debería resolverlo.', input: 'Ticket {{ticket.key}}: {{ticket.summary}}\n{{ticket.description}}' }),
        node('note', 'tool', 560, 160, { message: 'Ticket {{ticket.key}} recibido y clasificado.' }),
        node('end', 'end', 820, 160, {}),
      ],
      edges: [edge('trigger', 'ai'), edge('ai', 'note'), edge('note', 'end')],
      comments: [],
    },
  },
  {
    id: 'classify',
    name: 'Decidir según una regla',
    description: 'Bifurca el flujo según una condición (p. ej. la prioridad del ticket).',
    icon: '🔀',
    category: 'Automatización',
    doc: {
      nodes: [
        node('trigger', 'trigger', 40, 160, { event: 'manual' }),
        node('rule', 'condition', 300, 160, { expression: 'ticket.summary ~ urgente' }),
        node('yes', 'tool', 560, 80, { message: 'Es urgente: avisar al equipo.' }),
        node('no', 'tool', 560, 240, { message: 'No es urgente: a la cola normal.' }),
        node('end', 'end', 820, 160, {}),
      ],
      edges: [edge('trigger', 'rule'), edge('rule', 'yes', 'true'), edge('rule', 'no', 'false'), edge('yes', 'end'), edge('no', 'end')],
      comments: [],
    },
  },
];
