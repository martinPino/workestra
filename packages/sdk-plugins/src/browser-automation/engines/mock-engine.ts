import type {
  BrowserEngine,
  BrowserConfig,
  BrowserCookie,
  ConsoleLog,
  DownloadedFile,
  NetworkRequest,
  PageSnapshot,
  UploadFile,
} from '../types';

/**
 * Motor SIMULADO (M71). No abre un navegador real: mantiene un estado en memoria (URL actual, cookies,
 * acciones registradas) y devuelve resultados deterministas. Es el motor por defecto y el que usan los
 * tests/CI, de modo que TODA la arquitectura (sesiones, acciones, tool) se prueba sin Chromium. En producción
 * se cambia por un motor real (Playwright/Browserbase/…) sin tocar nada más. `live=false` avisa de que no
 * navega de verdad.
 */
export class MockBrowserEngine implements BrowserEngine {
  readonly name = 'mock' as const;
  readonly live = false;

  private launched = false;
  private url = 'about:blank';
  private title = 'Mock Page';
  private cookies: BrowserCookie[] = [];
  private readonly log: string[] = [];

  private ensure() {
    if (!this.launched) throw new Error('El navegador no está abierto (llama a browser_open primero).');
  }

  async launch(config: BrowserConfig): Promise<void> {
    this.launched = true;
    this.cookies = config.cookies ? [...config.cookies] : [];
    this.log.push(`launch ${JSON.stringify({ headless: config.headless ?? true })}`);
  }
  async close(): Promise<void> {
    this.launched = false;
    this.log.push('close');
  }

  async goto(url: string): Promise<{ url: string; status?: number }> {
    this.ensure();
    this.url = url;
    this.title = `Mock: ${new URL(url).host}`;
    this.log.push(`goto ${url}`);
    return { url, status: 200 };
  }
  async click(selector: string): Promise<void> {
    this.ensure();
    this.log.push(`click ${selector}`);
  }
  async doubleClick(selector: string): Promise<void> {
    this.ensure();
    this.log.push(`doubleClick ${selector}`);
  }
  async fill(selector: string, value: string): Promise<void> {
    this.ensure();
    this.log.push(`fill ${selector}=${value.length}chars`);
  }
  async type(selector: string, text: string): Promise<void> {
    this.ensure();
    this.log.push(`type ${selector}=${text.length}chars`);
  }
  async press(key: string): Promise<void> {
    this.ensure();
    this.log.push(`press ${key}`);
  }
  async hover(selector: string): Promise<void> {
    this.ensure();
    this.log.push(`hover ${selector}`);
  }
  async dragAndDrop(from: string, to: string): Promise<void> {
    this.ensure();
    this.log.push(`drag ${from}->${to}`);
  }
  async scroll(opts: { selector?: string; x?: number; y?: number }): Promise<void> {
    this.ensure();
    this.log.push(`scroll ${JSON.stringify(opts)}`);
  }
  async wait(ms: number): Promise<void> {
    this.ensure();
    this.log.push(`wait ${ms}`);
  }
  async waitForSelector(selector: string): Promise<void> {
    this.ensure();
    this.log.push(`waitForSelector ${selector}`);
  }

  async screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array> {
    this.ensure();
    this.log.push(`screenshot ${opts?.fullPage ? 'full' : 'viewport'}`);
    // PNG mínimo válido (1x1 transparente) para que aguas abajo se trate como imagen real.
    return PNG_1x1;
  }
  async pdf(): Promise<Uint8Array> {
    this.ensure();
    this.log.push('pdf');
    return new TextEncoder().encode('%PDF-1.4\n% mock pdf\n');
  }
  async snapshot(): Promise<PageSnapshot> {
    this.ensure();
    return { url: this.url, title: this.title, text: `Contenido simulado de ${this.url}` };
  }
  async extractText(selector?: string): Promise<string> {
    this.ensure();
    return `Texto simulado${selector ? ` de ${selector}` : ''} en ${this.url}`;
  }
  async getHTML(selector?: string): Promise<string> {
    this.ensure();
    return selector ? `<div data-mock="${selector}"></div>` : `<!doctype html><title>${this.title}</title>`;
  }
  async evaluate(script: string): Promise<unknown> {
    this.ensure();
    this.log.push(`evaluate ${script.length}chars`);
    return { ok: true, url: this.url };
  }
  async getCookies(): Promise<BrowserCookie[]> {
    this.ensure();
    return [...this.cookies];
  }
  async setCookies(cookies: BrowserCookie[]): Promise<void> {
    this.ensure();
    this.cookies = [...cookies];
  }
  async uploadFile(selector: string, files: UploadFile[]): Promise<void> {
    this.ensure();
    this.log.push(`upload ${selector} ${files.length} file(s)`);
  }
  async download(): Promise<DownloadedFile | null> {
    this.ensure();
    return { name: 'mock-download.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('mock download') };
  }
  async getConsoleLogs(): Promise<ConsoleLog[]> {
    this.ensure();
    return [{ level: 'log', text: 'mock console log', at: new Date(0).toISOString() }];
  }
  async getNetworkRequests(): Promise<NetworkRequest[]> {
    this.ensure();
    return [{ url: this.url, method: 'GET', status: 200, ok: true, resourceType: 'document' }];
  }

  /** Solo para tests/depuración: el registro de acciones ejecutadas. */
  actions(): readonly string[] {
    return this.log;
  }
}

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
