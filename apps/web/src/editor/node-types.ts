import type { NodeType } from '@core/contracts';
import { Zap, Wrench, GitBranch, Globe, BrainCircuit, Sparkles, Timer, UserCheck, Plug, Flag, type LucideIcon } from 'lucide-react';

/** Subconjunto de JSON Schema que entiende el NodePropertiesPanel. */
export interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'enum';
  label: string;
  default?: unknown;
  placeholder?: string;
  options?: string[]; // para type: 'enum'
  multiline?: boolean;
}

export interface NodeConfigSchema {
  title: string;
  fields: Record<string, FieldSchema>;
}

export interface NodeTypeDef {
  kind: NodeType | string;
  label: string;
  icon: LucideIcon;
  color: string; // clase Tailwind del acento
  category: 'trigger' | 'logic' | 'io' | 'ai' | 'control';
  configSchema: NodeConfigSchema;
}

/**
 * Registro INCREMENTAL de tipos de nodo. El editor (paleta, panel de propiedades, render) se
 * genera 100% desde aquí: añadir un tipo nuevo = `registerNodeType(...)`, sin tocar el núcleo.
 * En M2 solo se registran tipos con runtime existente o trivial.
 */
const REGISTRY = new Map<string, NodeTypeDef>();

export function registerNodeType(def: NodeTypeDef): void {
  REGISTRY.set(def.kind, def);
}

export function getNodeType(kind: string): NodeTypeDef | undefined {
  return REGISTRY.get(kind);
}

export function listNodeTypes(): NodeTypeDef[] {
  return [...REGISTRY.values()];
}

export function defaultConfig(kind: string): Record<string, unknown> {
  const def = REGISTRY.get(kind);
  if (!def) return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(def.configSchema.fields)) {
    if (field.default !== undefined) out[key] = field.default;
  }
  return out;
}

// --- Tipos base de M2 (runtime existente o trivial): Trigger, Log(Tool), Condición, HTTP, Fin ---

registerNodeType({
  kind: 'trigger',
  label: 'Trigger',
  icon: Zap,
  color: 'text-amber-400',
  category: 'trigger',
  configSchema: {
    title: 'Trigger',
    fields: {
      event: { type: 'enum', label: 'Evento', options: ['manual', 'webhook', 'cron'], default: 'manual' },
    },
  },
});

registerNodeType({
  kind: 'tool',
  label: 'Log / Tool',
  icon: Wrench,
  color: 'text-sky-400',
  category: 'logic',
  configSchema: {
    title: 'Log / Tool',
    fields: {
      message: { type: 'string', label: 'Mensaje', placeholder: 'Texto a registrar', multiline: true },
    },
  },
});

registerNodeType({
  kind: 'condition',
  label: 'Condición',
  icon: GitBranch,
  color: 'text-fuchsia-400',
  category: 'control',
  configSchema: {
    title: 'Condición',
    fields: {
      expression: {
        type: 'string',
        label: 'Expresión',
        placeholder: 'variables.count > 0',
        default: 'true',
      },
    },
  },
});

registerNodeType({
  kind: 'api',
  label: 'HTTP',
  icon: Globe,
  color: 'text-emerald-400',
  category: 'io',
  configSchema: {
    title: 'Petición HTTP',
    fields: {
      method: { type: 'enum', label: 'Método', options: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
      url: { type: 'string', label: 'URL', placeholder: 'https://api.example.com/…' },
    },
  },
});

registerNodeType({
  kind: 'agent',
  label: 'Agente',
  icon: BrainCircuit,
  color: 'text-indigo-400',
  category: 'ai',
  configSchema: {
    title: 'Agente',
    fields: {
      agentId: { type: 'string', label: 'Agent ID', placeholder: 'agent_1 (del registro de agentes)' },
    },
  },
});

registerNodeType({
  kind: 'llm',
  label: 'LLM',
  icon: Sparkles,
  color: 'text-amber-300',
  category: 'ai',
  configSchema: {
    title: 'LLM (inline)',
    fields: {
      model: {
        type: 'enum',
        label: 'Modelo',
        options: ['mock-1', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5'],
        default: 'mock-1',
      },
      prompt: { type: 'string', label: 'Prompt del sistema', placeholder: 'Eres un asistente útil.', multiline: true },
    },
  },
});

registerNodeType({
  kind: 'wait',
  label: 'Espera',
  icon: Timer,
  color: 'text-teal-400',
  category: 'control',
  configSchema: {
    title: 'Espera',
    fields: { ms: { type: 'number', label: 'Milisegundos', default: 500 } },
  },
});

registerNodeType({
  kind: 'human',
  label: 'Humano',
  icon: UserCheck,
  color: 'text-orange-400',
  category: 'control',
  configSchema: {
    title: 'Aprobación humana',
    fields: {
      reason: {
        type: 'string',
        label: 'Motivo de la revisión',
        placeholder: 'Aprobar el despliegue a producción…',
        multiline: true,
        default: 'Aprobación humana requerida',
      },
      ttlMs: { type: 'number', label: 'Caducidad (ms · 0 = sin límite)', default: 0 },
    },
  },
});

registerNodeType({
  kind: 'connector',
  label: 'Conector',
  icon: Plug,
  color: 'text-fuchsia-400',
  category: 'io',
  configSchema: {
    title: 'Conector (dispatch autenticado)',
    fields: {
      connectorId: { type: 'string', label: 'Connector ID', placeholder: 'conn_… (de Integraciones)' },
      method: { type: 'enum', label: 'Método', options: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
      path: { type: 'string', label: 'Ruta', placeholder: '/whoami' },
      body: { type: 'string', label: 'Cuerpo (JSON, opcional)', placeholder: '{"key":"value"}', multiline: true },
    },
  },
});

registerNodeType({
  kind: 'end',
  label: 'Fin',
  icon: Flag,
  color: 'text-zinc-300',
  category: 'control',
  configSchema: { title: 'Fin', fields: {} },
});
