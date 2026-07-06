import type { NodeType } from '@core/contracts';
import { Zap, Wrench, GitBranch, Globe, BrainCircuit, Sparkles, Timer, UserCheck, Plug, Flag, Split, type LucideIcon } from 'lucide-react';

/** Subconjunto de JSON Schema que entiende el NodePropertiesPanel. */
export interface FieldSchema {
  // `connector`/`agent`: desplegables poblados con los conectores/agentes del workspace (guarda su id).
  // `duration`: número + unidad (seg/min/horas/días) para gente que no piensa en milisegundos; guarda ms.
  type: 'string' | 'number' | 'boolean' | 'enum' | 'connector' | 'agent' | 'duration';
  label: string;
  default?: unknown;
  placeholder?: string;
  options?: string[]; // para type: 'enum'
  multiline?: boolean;
  // `json`: valida en vivo que el texto sea JSON válido (tolerando {{placeholders}}); solo advisory.
  format?: 'json';
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
  // `advanced`: bloque para desarrolladores (p. ej. HTTP crudo). Se oculta de la paleta en producción;
  // sigue registrado para que los flujos que ya lo usan se rendericen. M24 añadirá un toggle "avanzado".
  advanced?: boolean;
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
  advanced: true, // bloque técnico: fuera de la paleta para el usuario no-dev (M16)
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
      agentId: { type: 'agent', label: 'Agente' },
      input: {
        type: 'string',
        label: 'Tarea / entrada (opcional · admite {{variables}})',
        placeholder: 'Responde a este mensaje: {{connector:leer.bodyPreview}}',
        multiline: true,
      },
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
        // Gratis/baratos vía proveedor compatible OpenAI (LLM_BASE_URL): Groq / Ollama.
        options: [
          'mock-1',
          'llama-3.3-70b-versatile',
          'llama-3.1-8b-instant',
          'llama3.2',
          'claude-opus-4-8',
          'claude-sonnet-5',
          'claude-haiku-4-5',
          'gpt-5',
        ],
        default: 'mock-1',
      },
      prompt: { type: 'string', label: 'Prompt del sistema', placeholder: 'Eres un asistente útil y conciso.', multiline: true },
      input: {
        type: 'string',
        label: 'Tarea / entrada',
        placeholder: 'Responde a este mensaje: {{connector:leer.bodyPreview}}',
        multiline: true,
      },
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
    fields: { ms: { type: 'duration', label: 'Duración', default: 500 } },
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
      ttlMs: { type: 'duration', label: 'Caducidad (0 = sin límite)', default: 0 },
    },
  },
});

registerNodeType({
  kind: 'router',
  label: 'Router (coordinador)',
  icon: Split,
  color: 'text-teal-400',
  category: 'control',
  configSchema: {
    title: 'Router — el coordinador elige el agente',
    fields: {
      // El coordinador cuyo modelo decide a qué agente(s) conectados enrutar. Conecta este nodo a
      // varios nodos Agente: al ejecutar, solo corren los que el coordinador elija.
      agentId: { type: 'agent', label: 'Coordinador (decide)' },
      input: {
        type: 'string',
        label: 'Tarea a repartir (opcional · admite {{variables}})',
        placeholder: 'Investiga X y redacta un resumen',
        multiline: true,
      },
      // Límite de agentes elegidos. 0 = sin límite (los que decida). 1 = triaje a un único responsable.
      max: { type: 'number', label: 'Máx. agentes (0 = sin límite, 1 = uno solo)', default: 0 },
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
      connectorId: { type: 'connector', label: 'Conector' },
      method: { type: 'enum', label: 'Método', options: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
      path: { type: 'string', label: 'Ruta', placeholder: '/chat.postMessage' },
      // El cuerpo admite {{...}} para usar la salida de otros nodos (p. ej. la respuesta del agente).
      body: {
        type: 'string',
        label: 'Cuerpo (JSON, opcional · admite {{variables}})',
        placeholder: '{"channel":"#general","text":"{{agent:LLM.output}}"}',
        multiline: true,
        format: 'json',
      },
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
