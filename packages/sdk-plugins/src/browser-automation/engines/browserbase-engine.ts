import type { BrowserConfig } from '../types';
import { PlaywrightBasedEngine, dynamicImport, type PlaywrightHandles } from './playwright-based-engine';

const BROWSERBASE_API = 'https://api.browserbase.com/v1';

/**
 * Motor BROWSERBASE (M71) — el navegador corre REMOTO en Browserbase; nosotros NO metemos Chromium en el
 * despliegue. Flujo: crea una sesión remota vía su API (con la API key + projectId del workspace/plataforma),
 * obtiene su `connectUrl` (CDP) y lo maneja con `playwright-core` (cliente CDP ligero, sin navegador). Toda la
 * mecánica de página la hereda de `PlaywrightBasedEngine`. Se activa con `BROWSER_ENGINE=browserbase` +
 * `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`; el agente y los workflows no se enteran del cambio.
 */
export class BrowserbaseBrowserEngine extends PlaywrightBasedEngine {
  readonly name = 'browserbase' as const;
  private remoteSessionId: string | null = null;

  private static creds(): { apiKey: string; projectId: string } {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error('Browserbase no está configurado (faltan BROWSERBASE_API_KEY y/o BROWSERBASE_PROJECT_ID).');
    }
    return { apiKey, projectId };
  }

  protected async connect(config: BrowserConfig): Promise<PlaywrightHandles> {
    const { apiKey, projectId } = BrowserbaseBrowserEngine.creds();

    const res = await fetch(`${BROWSERBASE_API}/sessions`, {
      method: 'POST',
      headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        browserSettings: config.viewport ? { viewport: config.viewport } : undefined,
        proxies: config.proxy ? true : undefined,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`Browserbase no pudo crear la sesión (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const session = (await res.json()) as { id: string; connectUrl: string };
    this.remoteSessionId = session.id;

    let pw;
    try {
      pw = await dynamicImport('playwright-core');
    } catch {
      throw new Error('Falta «playwright-core» (cliente CDP para Browserbase) en este entorno.');
    }
    const browser = await pw.chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return { browser, context, page };
  }

  protected override async onClose(): Promise<void> {
    // Libera la sesión remota (best-effort) para no dejar navegadores colgando.
    if (!this.remoteSessionId) return;
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    const id = this.remoteSessionId;
    this.remoteSessionId = null;
    if (!apiKey || !projectId) return;
    await fetch(`${BROWSERBASE_API}/sessions/${id}`, {
      method: 'POST',
      headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REQUEST_RELEASE', projectId }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}
