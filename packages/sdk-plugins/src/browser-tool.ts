import type { ITool, ResolvedAuth, ToolDescription } from '@core/contracts';
import type { IFileStore } from '@core/engine';
import { BrowserAutomationService, type BrowserServiceDeps, type ArtifactSink } from './browser-automation/service';
import { BROWSER_ACTIONS, type BrowserActionName } from './browser-automation/schemas';

/** Sink de artefactos sobre un IFileStore: guarda capturas/PDF/descargas del navegador, aisladas por workspace. */
function fileStoreSink(files: IFileStore): ArtifactSink {
  return {
    put: async (kind, bytes, meta) => {
      const ws = meta.owner.workspaceId;
      if (!ws) throw new Error('no hay workspace para guardar el artefacto del navegador');
      const ref = await files.put(ws, { name: `browser-${kind}-${meta.name}`, mimeType: meta.mimeType, bytes });
      return { id: ref.id };
    },
  };
}

/**
 * «Browser Automation» (M71) — tool de agente que controla un navegador como un humano. Se ofrece a cualquier
 * agente igual que Jira/Slack/GitHub. Detrás hay un MOTOR intercambiable (Playwright/Browserbase/…): ni el
 * agente ni el workflow saben cuál. Es UNA sola tool cuyo parámetro `action` selecciona la operación (abrir,
 * navegar, click, rellenar, captura, PDF, extraer, evaluar JS, cookies, subir/descargar, snapshot, …). El
 * flujo típico: `browser_open` → devuelve `sessionId` → acciones con ese `sessionId` → `browser_close`.
 */
export interface BrowserToolDeps extends BrowserServiceDeps {
  /** Almacén de ficheros del workspace (Redis/Prisma). Si se pasa, las capturas/PDF/descargas se persisten y son visibles en el replay. */
  files?: IFileStore;
}

export class BrowserTool implements ITool {
  readonly key = 'browser';
  readonly idempotent = false;
  private readonly service: BrowserAutomationService;

  constructor(deps: BrowserToolDeps = {}) {
    const { files, ...serviceDeps } = deps;
    // Si nos dan un IFileStore y nadie inyectó ya un sink, guardamos los artefactos ahí (aislado por workspace).
    const artifacts = serviceDeps.artifacts ?? (files ? fileStoreSink(files) : undefined);
    this.service = new BrowserAutomationService({ ...serviceDeps, artifacts });
  }

  describe(): ToolDescription {
    return {
      description:
        'Controla un navegador web como un usuario (testing, login, formularios, scraping, capturas, PDFs, ' +
        'descargas/subidas, validación de UI/consola/HTTP). Empieza con action="browser_open" (devuelve sessionId) ' +
        'y usa ese sessionId en las siguientes acciones; cierra con action="browser_close" al terminar.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: [...BROWSER_ACTIONS], description: 'Operación del navegador a ejecutar.' },
          sessionId: { type: 'string', description: 'Sesión devuelta por browser_open (obligatorio salvo en browser_open).' },
          url: { type: 'string', description: 'URL para browser_open (opcional) y browser_goto.' },
          selector: { type: 'string', description: 'Selector CSS del elemento objetivo.' },
          value: { type: 'string', description: 'Valor para browser_fill.' },
          text: { type: 'string', description: 'Texto para browser_type.' },
          key: { type: 'string', description: 'Tecla para browser_press_key (p. ej. "Enter").' },
          ms: { type: 'number', description: 'Milisegundos para browser_wait.' },
          timeoutMs: { type: 'number', description: 'Timeout para browser_wait_for_selector.' },
          fullPage: { type: 'boolean', description: 'Captura de página completa en browser_take_screenshot.' },
          script: { type: 'string', description: 'JavaScript para browser_execute_javascript.' },
          from: { type: 'string', description: 'Selector origen en browser_drag_drop.' },
          to: { type: 'string', description: 'Selector destino en browser_drag_drop.' },
          x: { type: 'number' },
          y: { type: 'number' },
          cookies: { type: 'array', description: 'Cookies para browser_set_cookies.', items: { type: 'object' } },
          files: { type: 'array', description: 'Ficheros del workspace para browser_upload_file.', items: { type: 'object', properties: { fileId: { type: 'string' } } } },
          config: { type: 'object', description: 'Config opcional en browser_open (viewport, userAgent, proxy, locale, timezone, headless, timeout, slowMo).' },
        },
      },
    };
  }

  async invoke(input: unknown, auth: ResolvedAuth): Promise<unknown> {
    const { action, ...params } = (input ?? {}) as { action?: string };
    if (!action) return { error: `Falta "action". Válidas: ${BROWSER_ACTIONS.join(', ')}.` };
    if (!(BROWSER_ACTIONS as readonly string[]).includes(action)) {
      return { error: `Acción de navegador desconocida: ${action}.` };
    }
    // Contexto de ejecución (M72): el runtime del agente inyecta executionId/workspaceId/nodeKey/emit en `auth`.
    // Sirve para (1) aislar sesiones y artefactos por ejecución+workspace y (2) emitir cada acción al stream
    // del run para verla en el replay. Es opcional: fuera de una ejecución (p. ej. tests) simplemente no viene.
    const a = auth as { executionId?: unknown; workspaceId?: unknown; nodeKey?: unknown; emit?: unknown };
    const owner = {
      executionId: typeof a.executionId === 'string' ? a.executionId : undefined,
      workspaceId: typeof a.workspaceId === 'string' ? a.workspaceId : undefined,
    };
    const emit = typeof a.emit === 'function' ? (a.emit as (event: unknown) => void) : undefined;
    const nodeKey = typeof a.nodeKey === 'string' ? a.nodeKey : undefined;
    return this.service.run(action as BrowserActionName, params, owner, { emit, nodeKey });
  }
}
