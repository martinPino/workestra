import type { ExecutionContext } from '@core/contracts';

export interface ContextContribution {
  nodeKey: string;
  context: ExecutionContext;
}

/**
 * MergePolicy DETERMINISTA para el fan-in de ramas paralelas. Con copy-on-write en el runner
 * (cada nodo de un nivel recibe una copia del contexto base), aquí se combinan las contribuciones
 * en orden de `nodeKey` (determinista) con last-write-wins por clave. Mismo input → mismo output,
 * independientemente del orden de finalización de las ramas.
 */
export function mergeContexts(base: ExecutionContext, contributions: ContextContribution[]): ExecutionContext {
  const sorted = [...contributions].sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0));

  let ticket = { ...base.ticket };
  let repository = { ...base.repository };
  let memory = { ...base.memory };
  let variables = { ...base.variables };

  for (const c of sorted) {
    ticket = { ...ticket, ...(c.context.ticket as object) };
    repository = { ...repository, ...(c.context.repository as object) };
    memory = { ...memory, ...(c.context.memory as object) };
    variables = { ...variables, ...(c.context.variables as object) };
  }

  return { ...base, ticket, repository, memory, variables };
}
