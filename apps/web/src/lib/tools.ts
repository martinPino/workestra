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
