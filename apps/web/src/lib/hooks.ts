import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: api.listAgents });
export const useWorkflows = () => useQuery({ queryKey: ['workflows'], queryFn: api.listWorkflows });

/** Detalle de un workflow (incluye el grafo). Se usa para leer el evento del nodo Trigger. */
export const useWorkflow = (id: string | null) =>
  useQuery({ queryKey: ['workflow', id], queryFn: () => api.getWorkflow(id as string), enabled: !!id, retry: false });
export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 5000, retry: false });

/** Ejecuciones del workspace (recientes primero). Refresca cada 3s para reflejar cambios en vivo. */
export const useExecutions = (status?: string) =>
  useQuery({ queryKey: ['executions', status ?? 'all'], queryFn: () => api.listExecutions(status), refetchInterval: 3000, retry: false });

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

/** Catálogo de proveedores de conectores (M11). */
export const useConnectorProviders = () =>
  useQuery({ queryKey: ['connector-providers'], queryFn: api.listConnectorProviders, retry: false });

/** Conectores del workspace. `poll` acelera el refresco mientras un OAuth está en curso. */
export const useConnectors = (poll = false) =>
  useQuery({ queryKey: ['connectors'], queryFn: api.listConnectors, retry: false, refetchInterval: poll ? 1500 : false });
