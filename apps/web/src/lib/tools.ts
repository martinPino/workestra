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
  /** Color de marca para la insignia (M42). El texto de la inicial es blanco salvo `darkText`. */
  color: string;
  darkText?: boolean;
}

export const MCP_PRESETS: McpPreset[] = [
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', color: '#181717' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp', color: '#000000' },
  { name: 'Linear', url: 'https://mcp.linear.app/mcp', color: '#5E6AD2' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', color: '#362D59' },
  { name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/sse', color: '#0052CC' },
  { name: 'Stripe', url: 'https://mcp.stripe.com', color: '#635BFF' },
  { name: 'Hugging Face', url: 'https://huggingface.co/mcp', color: '#FFD21E', darkText: true },
  { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', color: '#1F6FEB' },
  { name: 'Context7', url: 'https://mcp.context7.com/mcp', color: '#0EA5E9' },
];

export const mcpPresetFor = (server: { url?: string; name?: string }): McpPreset | undefined =>
  MCP_PRESETS.find((p) => p.url === server.url) ?? (server.name ? MCP_PRESETS.find((p) => p.name === server.name) : undefined);
