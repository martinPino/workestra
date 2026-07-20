import { useQuery } from '@tanstack/react-query';
import type { EntityType, EventName } from '@core/contracts';
import { api, type InsightsQuery } from './api';

export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
export const useWorkflows = () => useQuery({ queryKey: ['workflows'], queryFn: api.listWorkflows });

/** Detalle de un workflow (incluye el grafo). Se usa para leer el evento del nodo Trigger. */
export const useWorkflow = (id: string | null) =>
  useQuery({ queryKey: ['workflow', id], queryFn: () => api.getWorkflow(id as string), enabled: !!id, retry: false });
export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 5000, retry: false });

/** Ejecuciones del workspace (recientes primero), opcionalmente por estado y/o workflow. Refresca cada 3s. */
export const useExecutions = (status?: string, workflowId?: string) =>
  useQuery({
    queryKey: ['executions', status ?? 'all', workflowId ?? 'all'],
    queryFn: () => api.listExecutions(status, workflowId),
    refetchInterval: 3000,
    retry: false,
  });

/** Revisiones humanas de una ejecución (para la bandeja de aprobación). */
export const useReviews = (executionId: string | null) =>
  useQuery({
    queryKey: ['reviews', executionId],
    queryFn: () => api.getReviews(executionId as string),
    enabled: !!executionId,
    retry: false,
  });

/** Webhooks (triggers entrantes) de un workflow. */
export const useWebhooks = (workflowId: string | null) =>
  useQuery({
    queryKey: ['webhooks', workflowId],
    queryFn: () => api.listWebhooks(workflowId as string),
    enabled: !!workflowId,
    retry: false,
  });

/** Triggers programados (cron/intervalo) de un workflow. */
export const useSchedules = (workflowId: string | null) =>
  useQuery({
    queryKey: ['schedules', workflowId],
    queryFn: () => api.listSchedules(workflowId as string),
    enabled: !!workflowId,
    retry: false,
  });

/** Disparadores de apps conectadas (M19, p. ej. eventos de Jira) de un workflow. */
export const useTriggerBindings = (workflowId: string | null) =>
  useQuery({
    queryKey: ['triggerBindings', workflowId],
    queryFn: () => api.listTriggerBindings(workflowId as string),
    enabled: !!workflowId,
    retry: false,
  });

/** Carpetas del Google Drive de un conector conectado (M54): pobla el desplegable del trigger. */
export const useDriveFolders = (connectorId: string | null) =>
  useQuery({
    queryKey: ['driveFolders', connectorId],
    queryFn: () => api.driveFolders(connectorId as string),
    enabled: !!connectorId,
    retry: false,
    staleTime: 60_000,
  });

/** Canales del Slack de un conector conectado (M57): pobla el desplegable «Canal» del nodo conector. */
export const useSlackChannels = (connectorId: string | null) =>
  useQuery({
    queryKey: ['slackChannels', connectorId],
    queryFn: () => api.slackChannels(connectorId as string),
    enabled: !!connectorId,
    retry: false,
    staleTime: 60_000,
  });

/** Proyectos del Sentry de un conector conectado (M79): pobla el desplegable «Proyecto» del trigger y acciones. */
export const useSentryProjects = (connectorId: string | null) =>
  useQuery({
    queryKey: ['sentryProjects', connectorId],
    queryFn: () => api.sentryProjects(connectorId as string),
    enabled: !!connectorId,
    retry: false,
    staleTime: 60_000,
  });

/** Repositorios del GitHub de un conector conectado: pobla el desplegable «Repositorio» de las acciones. */
export const useGithubRepos = (connectorId: string | null) =>
  useQuery({
    queryKey: ['githubRepos', connectorId],
    queryFn: () => api.githubRepos(connectorId as string),
    enabled: !!connectorId,
    retry: false,
    staleTime: 60_000,
  });

/** Catálogo de proveedores de conectores (M11). */
export const useConnectorProviders = () =>
  useQuery({ queryKey: ['connector-providers'], queryFn: api.listConnectorProviders, retry: false });

/** Conectores del workspace. `poll` acelera el refresco mientras un OAuth está en curso. */
export const useConnectors = (poll = false) =>
  useQuery({ queryKey: ['connectors'], queryFn: api.listConnectors, retry: false, refetchInterval: poll ? 1500 : false });

/* --- Analítica de producto (M84) -----------------------------------------------------------------
 *
 * Todo el panel lee de rollups, no de la tabla en crudo: refrescarlo cada pocos segundos solo repetiría
 * la misma respuesta, así que `staleTime` es alto a propósito.
 *
 * La clave lleva `days` y `scope`: dos ventanas distintas son dos consultas distintas, y así el mismo
 * `days` pedido dos veces en la página (p. ej. la cabecera de 30 días y el rango seleccionado de 30 días)
 * comparte una sola petición en vez de duplicarla.
 */

const INSIGHTS_OPTS = { retry: false, staleTime: 60_000 } as const;
const key = (q: InsightsQuery) => [q.days, q.scope ?? 'workspace'] as const;

/**
 * Qué puede ver quien pregunta. Lo consume el nav para ocultar «Analítica» a quien no es administrador
 * de plataforma; la API lo exige igual, así que esto solo evita enseñar una puerta que no abre.
 *
 * Sin permiso `analytics:read` la llamada da 403 y `data` se queda en `undefined` → el ítem no aparece.
 * Falla en cerrado, que es la dirección correcta para equivocarse.
 */
export const useInsightsMe = () =>
  useQuery({ queryKey: ['insights', 'me'], queryFn: api.insightsMe, retry: false, staleTime: 300_000 });

export const useInsightsOverview = (q: InsightsQuery) =>
  useQuery({ queryKey: ['insights', 'overview', ...key(q)], queryFn: () => api.insightsOverview(q), ...INSIGHTS_OPTS });

export const useInsightsEntities = (q: InsightsQuery & { name: EventName; entityType: EntityType }) =>
  useQuery({
    queryKey: ['insights', 'entities', q.name, q.entityType, ...key(q)],
    queryFn: () => api.insightsEntities(q),
    ...INSIGHTS_OPTS,
  });

export const useInsightsFeatures = (q: InsightsQuery) =>
  useQuery({ queryKey: ['insights', 'features', ...key(q)], queryFn: () => api.insightsFeatures(q), ...INSIGHTS_OPTS });

export const useInsightsRetention = (q: InsightsQuery & { cohortDays: number }) =>
  useQuery({
    queryKey: ['insights', 'retention', q.cohortDays, ...key(q)],
    queryFn: () => api.insightsRetention(q),
    ...INSIGHTS_OPTS,
  });

export const useInsightsSearch = (q: InsightsQuery) =>
  useQuery({ queryKey: ['insights', 'search', ...key(q)], queryFn: () => api.insightsSearch(q), ...INSIGHTS_OPTS });

export const useInsightsFunnel = (q: InsightsQuery & { steps: EventName[]; windowMinutes: number }) =>
  useQuery({
    queryKey: ['insights', 'funnel', q.steps.join(','), q.windowMinutes, ...key(q)],
    queryFn: () => api.insightsFunnel(q),
    ...INSIGHTS_OPTS,
  });
