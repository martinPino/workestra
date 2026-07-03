import type { ExecutionContext } from '@core/contracts';

/** Lee `path` (dot-notation) de un objeto. Los segmentos pueden contener `:` o espacios (claves de
 *  variables como `agent:LLM` o `connector:c`), pero NO `.` (el punto es el separador). */
function getPath(obj: unknown, path: string): unknown {
  return path
    .trim()
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/**
 * Resuelve `{{path}}` en `template` contra el contexto de ejecución — así un nodo puede usar la
 * SALIDA de otro (p. ej. el cuerpo de un conector `{"text":"{{agent:LLM.output}}"}` usa la respuesta
 * del agente, o `{{connector:c.bodyPreview}}` usa lo que devolvió otro conector). Es el motor de
 * flujo de datos entre nodos.
 *
 * Búsqueda: las variables del contexto están en la raíz (`{{connector:c...}}`), y también `ticket` /
 * `repository` / `variables`. `jsonSafe` escapa los valores string para incrustarlos dentro de un
 * JSON (p. ej. el cuerpo del conector) sin romper el formato.
 */
export function interpolate(template: string, ctx: ExecutionContext, jsonSafe = false): string {
  const lookup: Record<string, unknown> = {
    ...(ctx.variables as Record<string, unknown>),
    ticket: ctx.ticket,
    repository: ctx.repository,
    variables: ctx.variables,
  };
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const v = getPath(lookup, path);
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return jsonSafe ? JSON.stringify(v).slice(1, -1) : v;
    // No-string: se serializa; en JSON va crudo (sin comillas envolventes que el template ya aporta).
    return jsonSafe ? JSON.stringify(v).replace(/^"|"$/g, '') : JSON.stringify(v);
  });
}

/** ¿El texto contiene algún placeholder `{{...}}`? */
export function hasTemplate(s: string): boolean {
  return /\{\{[^}]+\}\}/.test(s);
}
