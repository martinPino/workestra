/**
 * Config-completeness de los nodos (M26): qué le falta a cada paso para FUNCIONAR —una app sin conectar
 * (credenciales), un asistente sin elegir…— para pintarlo como aviso visible en el lienzo (estilo n8n) y
 * avisar con claridad ANTES de ejecutar, en vez de dejar que reviente en runtime.
 *
 * Puro y testeable. Solo señales INEQUÍVOCAS y locales al nodo: preferimos no avisar a dar un falso positivo
 * (un aviso que no se puede quitar erosiona la confianza). Los textos van en español y los traduce quien pinta.
 */

export interface IssueCtx {
  /** Agentes del workspace (para validar que el elegido aún existe). `undefined` mientras carga. */
  agents?: { id: string }[];
  /** Conectores del workspace con su estado. `undefined` mientras carga. */
  connectors?: { id: string; status: string }[];
  // Estado de ERROR de las consultas (retry:false → si fallan, la lista queda undefined para siempre).
  // Sin esto no distinguiríamos «cargando» de «falló», y un flujo roto pasaría sin aviso ni bloqueo.
  agentsError?: boolean;
  connectorsError?: boolean;
}

export interface NodeIssues {
  nodeId: string;
  kind: string;
  issues: string[];
}

/** Textos de aviso de UN nodo (vacío = listo). No inventa avisos mientras las listas aún cargan. */
export function nodeSetupIssues(kind: string, config: Record<string, unknown> | undefined, ctx: IssueCtx): string[] {
  const cfg = config ?? {};
  const out: string[] = [];

  if (kind === 'connector') {
    const id = typeof cfg.connectorId === 'string' ? cfg.connectorId.trim() : '';
    if (!id) {
      out.push('Elige a qué app enviar');
    } else if (ctx.connectors) {
      // Solo comprobamos existencia/conexión cuando la lista YA cargó, para no dar un falso «no conectado».
      const c = ctx.connectors.find((x) => x.id === id);
      if (!c) out.push('La app elegida ya no existe: vuelve a elegirla');
      else if (c.status !== 'connected') out.push('Conecta esta app (faltan credenciales)');
    } else if (ctx.connectorsError) {
      // La lista falló al cargar: no podemos verificar → avisamos y bloqueamos (no lo damos por bueno).
      out.push('No se pudo comprobar la app (recarga la página)');
    }
  }

  if (kind === 'agent' || kind === 'router') {
    const id = typeof cfg.agentId === 'string' ? cfg.agentId.trim() : '';
    if (!id) {
      out.push(kind === 'router' ? 'Elige quién reparte el trabajo' : 'Elige un asistente');
    } else if (ctx.agents) {
      if (!ctx.agents.some((a) => a.id === id)) out.push('El asistente elegido ya no existe: vuelve a elegirlo');
    } else if (ctx.agentsError) {
      out.push('No se pudo comprobar el asistente (recarga la página)');
    }
  }

  return out;
}

/** Todos los nodos con problemas de configuración (para el banner y el guard pre-ejecución del editor). */
export function graphSetupIssues(
  nodes: { id: string; kind: string; config?: Record<string, unknown> }[],
  ctx: IssueCtx,
): NodeIssues[] {
  return nodes
    .map((n) => ({ nodeId: n.id, kind: n.kind, issues: nodeSetupIssues(n.kind, n.config, ctx) }))
    .filter((x) => x.issues.length > 0);
}
