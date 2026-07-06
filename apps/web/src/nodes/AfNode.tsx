import { Handle, Position, type NodeProps } from 'reactflow';
import { Square, Crown, TriangleAlert } from 'lucide-react';
import type { AfNodeData } from '../graph';
import { getNodeType } from '../editor/node-types';
import { nodeSetupIssues } from '../editor/node-issues';
import { ProviderLogo, hasProviderLogo } from '../lib/provider-logos';
import { useAgents, useConnectors } from '../lib/hooks';
import { agentGradient, agentInitial } from '../lib/agent-avatar';
import { useT } from '../i18n';

const STATUS_RING: Record<string, string> = {
  running: 'ring-2 ring-primary shadow-[0_0_18px_rgb(var(--primary)/0.35)]',
  waiting: 'ring-2 ring-warning shadow-[0_0_18px_rgb(var(--warning)/0.4)] animate-pulse',
  succeeded: 'ring-2 ring-success shadow-[0_0_18px_rgb(var(--success)/0.35)]',
  failed: 'ring-2 ring-danger shadow-[0_0_18px_rgb(var(--danger)/0.35)]',
  skipped: 'opacity-60',
};

const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-border !bg-elevated';

export function AfNode({ data, selected }: NodeProps<AfNodeData>) {
  const t = useT();
  const def = getNodeType(data.kind);
  const Icon = def?.icon ?? Square;
  const statusRing = data.status ? (STATUS_RING[data.status] ?? '') : '';
  const selectedRing = selected ? 'ring-2 ring-primary' : '';

  // Nodo Agente: si hay un agente elegido, la carta muestra SU avatar + nombre (identidad real),
  // no el label genérico. El avatar (gradiente + inicial) es determinista por id → mismo color que
  // en la galería de Agentes. Corona si es coordinador. Se resuelve del registro del workspace.
  const agentsQuery = useAgents();
  const connectorsQuery = useConnectors();
  const agents = agentsQuery.data;
  const connectors = connectorsQuery.data;
  const agent =
    (data.kind === 'agent' || data.kind === 'router') && data.config?.agentId
      ? agents?.find((a) => a.id === String(data.config?.agentId))
      : undefined;

  // Nodo Conector: muestra el LOGO real de la app destino (Slack/Jira/GitHub) en vez del enchufe genérico.
  const connectorProvider =
    data.kind === 'connector' && data.config?.connectorId
      ? connectors?.find((c) => c.id === String(data.config?.connectorId))?.provider
      : undefined;
  const showLogo = hasProviderLogo(connectorProvider);

  // «Falta configurar» (M26): avisos visibles en el propio nodo (estilo n8n), p. ej. app sin conectar o
  // asistente sin elegir. Vacío = el paso está listo. El flag de error distingue «falló la carga» de «cargando».
  const issues = nodeSetupIssues(data.kind, data.config, {
    agents,
    connectors,
    agentsError: agentsQuery.isError,
    connectorsError: connectorsQuery.isError,
  });

  return (
    <div
      className={`relative min-w-[156px] max-w-[220px] rounded-xl border border-border bg-card px-2.5 py-2 text-xs text-txt-primary shadow-card transition-all duration-150 hover:border-border-strong ${statusRing} ${selectedRing}`}
    >
      {issues.length > 0 && (
        <span
          title={issues.map((i) => t(i)).join('\n')}
          aria-label={`${t('Falta configurar este paso')}: ${issues.map((i) => t(i)).join('. ')}`}
          className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border-2 border-card bg-amber-400 text-amber-950 shadow-card"
        >
          <TriangleAlert size={11} strokeWidth={2.75} />
        </span>
      )}
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      {agent ? (
        <div className="flex items-center gap-2.5">
          <span
            className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${agentGradient(agent.id)} text-[13px] font-semibold text-white shadow-subtle`}
          >
            {agent.isOrchestrator ? <Crown size={14} /> : agentInitial(agent.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-txt-primary">{agent.name}</span>
            <span className="block truncate text-[10px] text-txt-disabled">{agent.model}</span>
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border ${
              showLogo ? 'bg-white text-neutral-900' : `bg-elevated ${def?.color ?? 'text-txt-primary'}`
            }`}
          >
            {showLogo ? <ProviderLogo provider={connectorProvider} size={16} /> : <Icon size={15} strokeWidth={2} />}
          </span>
          <span className="truncate font-medium text-txt-primary">{def?.label ? t(def.label) : data.kind}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
    </div>
  );
}
