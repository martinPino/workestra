import { useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Square, Crown, TriangleAlert, Settings2, Power, Copy, Trash2, Clock, UserRound, Webhook } from 'lucide-react';
import type { AfNodeData } from '../graph';
import { getNodeType } from '../editor/node-types';
import { nodeSetupIssues } from '../editor/node-issues';
import { ProviderLogo, hasProviderLogo } from '../lib/provider-logos';
import { useAgents, useConnectors } from '../lib/hooks';
import { agentGradient, agentInitial } from '../lib/agent-avatar';
import { useEditorStore } from '../editor/store';
import { cn } from '../lib/cn';
import { AgentToolsPort } from './AgentToolsPort';
import { NodeStatusBadge } from './NodeStatusBadge';
import { useT } from '../i18n';

// Color de borde + glow por estado de ejecución (M65). El aro de energía giratorio, el pulso de
// llegada y el «sonar» de los nodos lentos son CAPAS superpuestas (ver más abajo), no `ring-*`, para
// no chocar con el anillo de selección (`ring-2 ring-primary`).
const STATUS_BORDER: Record<string, string> = {
  running: 'border-flow/70',
  waiting: 'border-warning/70',
  succeeded: 'border-success/70',
  failed: 'border-danger/80',
};
const STATUS_GLOW: Record<string, string> = {
  // succeeded/failed conservan un glow persistente = «rastro de ejecución» (nodo ya recorrido).
  waiting: 'shadow-[0_0_16px_rgb(var(--warning)/0.35)] animate-pulse',
  succeeded: 'shadow-[0_0_14px_rgb(var(--success)/0.28)]',
  failed: 'shadow-[0_0_18px_rgb(var(--danger)/0.4)]',
};

const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-border !bg-elevated';
const TOOL_BTN = 'flex h-6 w-6 items-center justify-center rounded-md text-txt-secondary transition-colors hover:bg-card hover:text-txt-primary';

export function AfNode({ id, data, selected }: NodeProps<AfNodeData>) {
  const t = useT();
  const def = getNodeType(data.kind);
  const Icon = def?.icon ?? Square;
  const disabled = !!data.disabled;
  const status = data.status;
  const running = status === 'running';
  // «Está pensando» (M65): a los 800ms de ejecución el nodo escala su animación (glow que respira +
  // pulso sonar) para que NUNCA parezca congelado, aunque una IA tarde 20s. Reloj de cliente: el
  // estado reducido no lleva marcas de tiempo (reducer puro), así que lo cronometramos aquí.
  const [longRun, setLongRun] = useState(false);
  useEffect(() => {
    if (!running) {
      setLongRun(false);
      return;
    }
    const timer = setTimeout(() => setLongRun(true), 800);
    return () => clearTimeout(timer);
  }, [running]);

  const borderCls = (status && STATUS_BORDER[status]) || 'border-border';
  const glowCls = (status && STATUS_GLOW[status]) || '';
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

  // Nodo Disparador (M72): el icono cuenta CÓMO arranca el flujo — el logo real de la app cuando lo
  // dispara Jira/Google Drive, una persona si lo lanza el usuario a mano, un reloj si es por horario,
  // y el icono de webhook para eventos externos. El `eventId` guarda la elección humana (ver TriggerForm);
  // su prefijo antes del punto es el proveedor (`jira.issue_created` → `jira`).
  let triggerProvider: string | undefined;
  let TriggerIcon = Icon;
  if (data.kind === 'trigger') {
    const eventId = String(data.config?.eventId ?? '');
    const provider = eventId.includes('.') ? eventId.slice(0, eventId.indexOf('.')) : '';
    if (hasProviderLogo(provider)) triggerProvider = provider;
    else if (eventId === 'schedule' || data.config?.event === 'cron') TriggerIcon = Clock;
    else if (eventId === 'webhook' || data.config?.event === 'webhook') TriggerIcon = Webhook;
    else TriggerIcon = UserRound; // manual (por defecto)
  }

  // Un logo de marca (conector destino o disparador de app) va sobre fondo blanco; el resto usa el acento del nodo.
  const logoProvider = triggerProvider ?? (hasProviderLogo(connectorProvider) ? connectorProvider : undefined);
  const showLogo = !!logoProvider;

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
      className={cn(
        'group relative min-w-[156px] max-w-[220px] rounded-xl border bg-elevated px-2.5 py-2 text-xs text-txt-primary shadow-card transition-all duration-200',
        borderCls,
        glowCls,
        disabled && 'opacity-50',
        status === 'skipped' && 'opacity-55',
        status === 'failed' && 'af-shake',
        selected && 'ring-2 ring-primary',
        !status && 'hover:border-border-strong',
      )}
    >
      {/* Capas de ejecución en vivo (M65): huecas/exteriores y pointer-events-none → no tapan el
          contenido ni la barra flotante (z-20) / avisos (z-10). Solo se montan mientras el nodo corre. */}
      {running && (
        <>
          <span aria-hidden className="af-arrival" />
          <span aria-hidden className="af-ring" />
          {longRun && <span aria-hidden className="af-glow" />}
          {longRun && <span aria-hidden className="af-sonar" />}
        </>
      )}
      {/* Sello de resultado (M66): tras ejecutarse, ✓ verde (éxito) o ✗ roja (fallo) abajo a la derecha.
          Si falló, al pasar el cursor abre un globo con el error / lo que falta. */}
      {(status === 'succeeded' || status === 'failed') && <NodeStatusBadge status={status} error={data.error} />}

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

      {/* Aviso «falta configurar» SOLO en reposo (sin estado de ejecución): durante/tras un run manda el
          estado del run (evita solaparse con el check de éxito en la misma esquina, y en el replay una
          ejecución antigua no debe mostrar avisos de config del workspace actual). */}
      {issues.length > 0 && !status && (
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
            {showLogo ? <ProviderLogo provider={logoProvider} size={16} /> : <TriggerIcon size={15} strokeWidth={2} />}
          </span>
          <span className="truncate font-medium text-txt-primary">{def?.label ? t(def.label) : data.kind}</span>
        </div>
      )}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />

      {/* Puerto «Herramientas» (M39): en un nodo Agente con agente resuelto, cuelga bajo la tarjeta los tools
          del agente + un «+» para añadir/quitar (edita el agente; su runtime las usa). Oculto si está apagado. */}
      {agent && !disabled && (data.editable || (agent.tools?.length ?? 0) > 0 || (agent.mcpServers?.length ?? 0) > 0) && (
        <AgentToolsPort agentId={agent.id} tools={agent.tools ?? []} mcpServers={agent.mcpServers ?? []} editable={!!data.editable} />
      )}
    </div>
  );
}
