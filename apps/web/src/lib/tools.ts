import { Globe, Wrench, type LucideIcon } from 'lucide-react';

/**
 * Catálogo de herramientas que un agente puede usar (M39). Coincide con las tools HABILITADAS del runtime
 * (autorizadas por RBAC; ver la página Acciones). Al asignarlas a un agente, su runtime hace tool-calling con
 * ellas. Las claves (`http`, `mock`) son las que entiende el motor; las etiquetas son para humanos.
 */
export interface ToolDef {
  key: string;
  label: string;
  desc: string;
  icon: LucideIcon;
}

export const TOOL_CATALOG: ToolDef[] = [
  { key: 'http', label: 'Petición web', desc: 'Llama a una API por HTTP.', icon: Globe },
  { key: 'mock', label: 'Eco de prueba', desc: 'Devuelve lo que recibe (para pruebas).', icon: Wrench },
];

export const toolLabel = (key: string): string => TOOL_CATALOG.find((c) => c.key === key)?.label ?? key;

/**
 * Servidores MCP populares para añadir de un clic (M41), sin escribir la URL. Son endpoints MCP remotos
 * conocidos. Muchos requieren iniciar sesión / clave: si es así, el usuario pega la URL con su clave desde
 * «Añadir servidor MCP». Los públicos (DeepWiki, Context7, Hugging Face) funcionan sin credenciales.
 */
export interface McpPreset {
  name: string;
  url: string;
}

export const MCP_PRESETS: McpPreset[] = [
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp' },
  { name: 'Linear', url: 'https://mcp.linear.app/mcp' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/sse' },
  { name: 'Stripe', url: 'https://mcp.stripe.com' },
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp' },
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp' },
  { name: 'Context7', url: 'https://mcp.context7.com/mcp' },
];
