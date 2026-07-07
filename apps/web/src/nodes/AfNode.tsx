import { Handle, Position, type NodeProps } from 'reactflow';
import { Square, Crown, TriangleAlert, Settings2, Power, Copy, Trash2 } from 'lucide-react';
import type { AfNodeData } from '../graph';
import { getNodeType } from '../editor/node-types';
import { nodeSetupIssues } from '../editor/node-issues';
import { ProviderLogo, hasProviderLogo } from '../lib/provider-logos';
import { useAgents, useConnectors } from '../lib/hooks';
import { agentGradient, agentInitial } from '../lib/agent-avatar';
import { useEditorStore } from '../editor/store';
import { AgentToolsPort } from './AgentToolsPort';
import { useT } from '../i18n';

const STATUS_RING: Record<string, string> = {
  running: 'ring-2 ring-primary shadow-[0_0_18px_rgb(var(--primary)/0.35)]',
  waiting: 'ring-2 ring-warning shadow-[0_0_18px_rgb(var(--warning)/0.4)] animate-pulse',
  succeeded: 'ring-2 ring-success shadow-[0_0_18px_rgb(var(--success)/0.35)]',
  failed: 'ring-2 ring-danger shadow-[0_0_18px_rgb(var(--danger)/0.35)]',
  skipped: 'opacity-60',
};

const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-border !bg-elevated';
const TOOL_BTN = 'flex h-6 w-6 items-center justify-center rounded-md text-txt-secondary transition-colors hover:bg-card hover:text-txt-primary';

export function AfNode({ id, data, selected }: NodeProps<AfNodeData>) {
  const t = useT();
  const def = getNodeType(data.kind);
  const Icon = def?.icon ?? Square;
  const disabled = !!data.disabled;
  const statusRing = data.status ? (STATUS_RING[data.status] ?? '') : '';
  const selectedRing = selected ? 'ring-2 ring-primary' : '';
  // Los pasos estructurales (inicio/fin) no se pueden desactivar: el motor los necesita.
  const structural = data.kind === 'trigger' || data.kind === 'end';

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

  // «Falta configurar» (M26): avisos visibles en el propio nodo. Un paso DESACTIVADO no molesta con avisos
  // (no se va a ejecutar), así que se ocultan mientras esté apagado.
  const issues = disabled
    ? []
    : nodeSetupIssues(data.kind, data.config, {
        agents,
        connectors,
        agentsError: agentsQuery.isError,
        connectorsError: connectorsQuery.isError,
      });

  return (
    <div
      className={`group relative min-w-[156px] max-w-[220px] rounded-xl border border-border bg-elevated px-2.5 py-2 text-xs text-txt-primary shadow-card transition-all duration-150 hover:border-border-strong ${disabled ? 'opacity-50' : ''} ${statusRing} ${selectedRing}`}
    >
      {/* Barra flotante de controles (M38, estilo n8n): aparece SOLO al pasar el ratón, y solo en el editor.
          El `pb-1.5` del contenedor externo hace de puente sin hueco entre el nodo y la barra. */}
      {data.editable && (
        <div className="nodrag absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-1.5 opacity-0 transition-opacity duration-100 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-elevated px-1 py-0.5 shadow-pop">
            {/* Ajustes: deja pasar el clic al nodo (onNodeClick) para abrir el inspector. */}
            <button
              type="button"
              title={t('Ajustes')}
              aria-label={t('Ajustes')}
              onClick={() => useEditorStore.getState().setSelection([id], [])}
              className={TOOL_BTN}
            >
              <Settings2 size={13} />
            </button>
            {!structural && (
              <button
                type="button"
                title={disabled ? t('Activar paso') : t('Desactivar paso')}
                aria-label={disabled ? t('Activar paso') : t('Desactivar paso')}
                onClick={(e) => {
                  e.stopPropagation();
                  useEditorStore.getState().toggleNodeDisabled(id);
                }}
                className={`${TOOL_BTN} ${disabled ? 'text-warning' : ''}`}
              >
                <Power size={13} />
              </button>
            )}
            <button
              type="button"
              title={t('Duplicar')}
              aria-label={t('Duplicar')}
              onClick={(e) => {
                e.stopPropagation();
                useEditorStore.getState().duplicateNode(id);
              }}
              className={TOOL_BTN}
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              title={t('Borrar')}
              aria-label={t('Borrar')}
              onClick={(e) => {
                e.stopPropagation();
                useEditorStore.getState().removeNodeById(id);
              }}
              className={`${TOOL_BTN} hover:text-danger`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      )}

      {disabled && (
        <span className="absolute -bottom-2.5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-elevated px-2 py-px text-[9px] font-semibold uppercase tracking-wide text-txt-disabled shadow-subtle">
          {t('Desactivado')}
        </span>
      )}

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
              showLogo ? 'bg-white text-neutral-900' : `bg-card ${def?.color ?? 'text-txt-primary'}`
            }`}
          >
            {showLogo ? <ProviderLogo provider={connectorProvider} size={16} /> : <Icon size={15} strokeWidth={2} />}
          </span>
          <span className="truncate font-medium text-txt-primary">{def?.label ? t(def.label) : data.kind}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />

      {/* Puerto «Herramientas» (M39): en un nodo Agente con agente resuelto, cuelga bajo la tarjeta los tools
          del agente + un «+» para añadir/quitar (edita el agente; su runtime las usa). Oculto si está apagado. */}
      {agent && !disabled && (data.editable || (agent.tools?.length ?? 0) > 0) && (
        <AgentToolsPort agentId={agent.id} tools={agent.tools ?? []} editable={!!data.editable} />
      )}
    </div>
  );
}
