import { z } from 'zod';
import type { UploadFile } from './types';
import { BrowserSessionManager, type SessionOwner, type SessionManagerDeps } from './session-manager';
import { ACTION_PARAM_SCHEMAS, type BrowserActionName } from './schemas';
import { checkNavigation, defaultSecurityPolicy, type BrowserSecurityPolicy } from './security';
import { createBrowserEngine } from './engines/factory';

/** Resultado de una acción: siempre serializable y compacto (el agente lo lee resumido). */
export type ActionResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

/** Cómo el servicio persiste artefactos (capturas, PDF, descargas). Fase 2 inyecta un sink real (IFileStore). */
export interface ArtifactSink {
  put(kind: 'screenshot' | 'pdf' | 'download', bytes: Uint8Array, meta: { name: string; mimeType: string; owner: SessionOwner }): Promise<{ id: string }>;
}
/** Resuelve una referencia de fichero del workspace a bytes (para subidas). Fase 2 inyecta uno real. */
export interface UploadResolver {
  resolve(fileId: string, owner: SessionOwner): Promise<UploadFile | null>;
}

export interface BrowserServiceDeps extends Partial<Pick<SessionManagerDeps, 'createEngine' | 'engineName' | 'now' | 'genId'>> {
  policy?: BrowserSecurityPolicy;
  artifacts?: ArtifactSink;
  uploads?: UploadResolver;
}

/**
 * Servicio de Browser Automation (M71): recibe el NOMBRE de una acción + parámetros, los valida (Zod), aplica
 * seguridad (dominios) y la ejecuta contra el MOTOR a través del gestor de sesiones. No conoce Playwright ni
 * ningún motor concreto — sólo `BrowserEngine`. Es lo que invoca la tool del agente.
 */
export class BrowserAutomationService {
  readonly sessions: BrowserSessionManager;
  private readonly policy: BrowserSecurityPolicy;
  private readonly artifacts?: ArtifactSink;
  private readonly uploads?: UploadResolver;

  constructor(deps: BrowserServiceDeps = {}) {
    // Fábrica por defecto → motor por env (o mock). Inyectable en tests para forzar un motor concreto.
    const createEngine = deps.createEngine ?? ((name) => createBrowserEngine(name));
    this.policy = deps.policy ?? defaultSecurityPolicy();
    this.artifacts = deps.artifacts;
    this.uploads = deps.uploads;
    this.sessions = new BrowserSessionManager({ createEngine, engineName: deps.engineName, policy: this.policy, now: deps.now, genId: deps.genId });
  }

  /** Ejecuta una acción del navegador. Nunca lanza: los errores vuelven como `{ ok:false, error }`. */
  async run(action: BrowserActionName, rawParams: unknown, owner: SessionOwner = {}): Promise<ActionResult> {
    const schema = ACTION_PARAM_SCHEMAS[action] as z.ZodTypeAny | undefined;
    if (!schema) return { ok: false, error: `Acción de navegador desconocida: ${action}` };
    const parsed = schema.safeParse(rawParams ?? {});
    if (!parsed.success) return { ok: false, error: `Parámetros inválidos para ${action}: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
    const p = parsed.data as Record<string, unknown>;

    try {
      return await this.dispatch(action, p, owner);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async dispatch(action: BrowserActionName, p: Record<string, unknown>, owner: SessionOwner): Promise<ActionResult> {
    if (action === 'browser_open') {
      const url = p.url as string | undefined;
      if (url) {
        const nav = checkNavigation(url, this.policy);
        if (!nav.ok) return { ok: false, error: nav.reason! };
      }
      const session = await this.sessions.open(owner, (engine) => engine.launch((p.config as never) ?? {}));
      let opened: { url: string; status?: number } | undefined;
      if (url) opened = await session.engine.goto(url);
      return { ok: true, sessionId: session.id, engine: session.engine.name, live: session.engine.live, url: opened?.url };
    }

    const sessionId = p.sessionId as string;
    if (action === 'browser_close') {
      await this.sessions.close(sessionId);
      return { ok: true, closed: true };
    }

    const session = await this.sessions.use(sessionId);
    const e = session.engine;

    switch (action) {
      case 'browser_goto': {
        const nav = checkNavigation(p.url as string, this.policy);
        if (!nav.ok) return { ok: false, error: nav.reason! };
        const r = await e.goto(p.url as string);
        return { ok: true, url: r.url, status: r.status };
      }
      case 'browser_click':
        await e.click(p.selector as string);
        return { ok: true };
      case 'browser_double_click':
        await e.doubleClick(p.selector as string);
        return { ok: true };
      case 'browser_fill':
        await e.fill(p.selector as string, p.value as string);
        return { ok: true };
      case 'browser_type':
        await e.type(p.selector as string, p.text as string);
        return { ok: true };
      case 'browser_press_key':
        await e.press(p.key as string);
        return { ok: true };
      case 'browser_hover':
        await e.hover(p.selector as string);
        return { ok: true };
      case 'browser_drag_drop':
        await e.dragAndDrop(p.from as string, p.to as string);
        return { ok: true };
      case 'browser_scroll':
        await e.scroll({ selector: p.selector as string | undefined, x: p.x as number | undefined, y: p.y as number | undefined });
        return { ok: true };
      case 'browser_wait':
        await e.wait(p.ms as number);
        return { ok: true };
      case 'browser_wait_for_selector':
        await e.waitForSelector(p.selector as string, p.timeoutMs as number | undefined);
        return { ok: true };
      case 'browser_take_screenshot': {
        const bytes = await e.screenshot({ fullPage: p.fullPage as boolean | undefined });
        return this.artifactResult('screenshot', bytes, 'screenshot.png', 'image/png', owner);
      }
      case 'browser_generate_pdf': {
        const bytes = await e.pdf();
        return this.artifactResult('pdf', bytes, 'page.pdf', 'application/pdf', owner);
      }
      case 'browser_extract_text': {
        const text = await e.extractText(p.selector as string | undefined);
        return { ok: true, text: text.slice(0, 8000), length: text.length };
      }
      case 'browser_get_html': {
        const html = await e.getHTML(p.selector as string | undefined);
        return { ok: true, html: html.slice(0, 8000), length: html.length };
      }
      case 'browser_execute_javascript': {
        const value = await e.evaluate(p.script as string);
        return { ok: true, result: value };
      }
      case 'browser_get_cookies':
        return { ok: true, cookies: await e.getCookies() };
      case 'browser_set_cookies':
        await e.setCookies(p.cookies as never);
        return { ok: true };
      case 'browser_get_console_logs':
        return { ok: true, logs: await e.getConsoleLogs() };
      case 'browser_get_network_requests':
        return { ok: true, requests: (await e.getNetworkRequests()).slice(0, 50) };
      case 'browser_take_snapshot': {
        const snap = await e.snapshot();
        return { ok: true, ...snap, text: snap.text.slice(0, 4000) };
      }
      case 'browser_upload_file': {
        const refs = p.files as Array<{ fileId: string }>;
        if (!this.uploads) return { ok: false, error: 'Subida de ficheros no disponible en este entorno.' };
        const files: UploadFile[] = [];
        for (const ref of refs) {
          const f = await this.uploads.resolve(ref.fileId, owner);
          if (!f) return { ok: false, error: `Fichero no encontrado: ${ref.fileId}` };
          files.push(f);
        }
        await e.uploadFile(p.selector as string, files);
        return { ok: true, uploaded: files.length };
      }
      case 'browser_download_file': {
        const dl = await e.download();
        if (!dl) return { ok: false, error: 'No hay ninguna descarga disponible.' };
        return this.artifactResult('download', dl.bytes, dl.name, dl.mimeType, owner);
      }
      default:
        return { ok: false, error: `Acción no implementada: ${action}` };
    }
  }

  /** Persiste el artefacto si hay sink; si no, devuelve sólo el tamaño (fase 2 añade el almacén real). */
  private async artifactResult(
    kind: 'screenshot' | 'pdf' | 'download',
    bytes: Uint8Array,
    name: string,
    mimeType: string,
    owner: SessionOwner,
  ): Promise<ActionResult> {
    if (this.artifacts) {
      const { id } = await this.artifacts.put(kind, bytes, { name, mimeType, owner });
      return { ok: true, [`${kind}FileId`]: id, bytes: bytes.length, mimeType };
    }
    return { ok: true, [kind]: 'captured', bytes: bytes.length, mimeType, note: 'almacenamiento de artefactos pendiente de configurar' };
  }
}
