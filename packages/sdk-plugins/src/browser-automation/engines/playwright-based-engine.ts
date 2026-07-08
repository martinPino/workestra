import type {
  BrowserEngine,
  BrowserEngineName,
  BrowserConfig,
  BrowserCookie,
  ConsoleLog,
  DownloadedFile,
  NetworkRequest,
  PageSnapshot,
  UploadFile,
} from '../types';

/** browser/context/page de Playwright (tipados como `any` para no acoplar el build a Playwright). */
export interface PlaywrightHandles {
  browser: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  context: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  page: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Base común para los motores manejados con Playwright vía CDP (M71). TODA la mecánica de la página
 * (goto/click/screenshot/…) vive aquí; lo ÚNICO que cambia entre motores es cómo se OBTIENE el navegador:
 *  - Playwright local: `chromium.launch()` (fase de infra propia).
 *  - Browserbase: crea una sesión remota y `chromium.connectOverCDP(connectUrl)`.
 * Así «agent → browser_open() → BrowserEngine → (Playwright|Browserbase)» sin que nada más lo note.
 */
export abstract class PlaywrightBasedEngine implements BrowserEngine {
  abstract readonly name: BrowserEngineName;
  readonly live = true;

  protected browser: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  protected context: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  protected page: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  protected defaultTimeout = 30_000;
  private readonly consoleLogs: ConsoleLog[] = [];
  private readonly network: NetworkRequest[] = [];
  private pendingDownload: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Obtiene browser/context/page (local o remoto). Lo implementa cada motor. */
  protected abstract connect(config: BrowserConfig): Promise<PlaywrightHandles>;
  /** Hook opcional al cerrar (p. ej. liberar la sesión remota de Browserbase). */
  protected async onClose(): Promise<void> {}

  protected ensure() {
    if (!this.page) throw new Error('El navegador no está abierto (llama a browser_open primero).');
  }

  async launch(config: BrowserConfig): Promise<void> {
    this.defaultTimeout = config.timeoutMs ?? 30_000;
    const { browser, context, page } = await this.connect(config);
    this.browser = browser;
    this.context = context;
    this.page = page;
    await this.context.setDefaultTimeout?.(this.defaultTimeout);
    if (config.cookies?.length) await this.context.addCookies(config.cookies).catch(() => undefined);
    this.page.on('console', (m: any) => this.consoleLogs.push({ level: m.type(), text: m.text(), at: new Date().toISOString() })); // eslint-disable-line @typescript-eslint/no-explicit-any
    this.page.on('response', (r: any) => this.network.push({ url: r.url(), method: r.request().method(), status: r.status(), ok: r.ok(), resourceType: r.request().resourceType() })); // eslint-disable-line @typescript-eslint/no-explicit-any
    this.page.on('download', (d: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      this.pendingDownload = d;
    });
  }

  async close(): Promise<void> {
    await this.onClose().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = this.context = this.browser = null;
  }

  async goto(url: string): Promise<{ url: string; status?: number }> {
    this.ensure();
    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    return { url: this.page.url(), status: res ? res.status() : undefined };
  }
  async click(selector: string): Promise<void> {
    this.ensure();
    await this.page.click(selector);
  }
  async doubleClick(selector: string): Promise<void> {
    this.ensure();
    await this.page.dblclick(selector);
  }
  async fill(selector: string, value: string): Promise<void> {
    this.ensure();
    await this.page.fill(selector, value);
  }
  async type(selector: string, text: string): Promise<void> {
    this.ensure();
    await this.page.type(selector, text);
  }
  async press(key: string): Promise<void> {
    this.ensure();
    await this.page.keyboard.press(key);
  }
  async hover(selector: string): Promise<void> {
    this.ensure();
    await this.page.hover(selector);
  }
  async dragAndDrop(from: string, to: string): Promise<void> {
    this.ensure();
    await this.page.dragAndDrop(from, to);
  }
  async scroll(opts: { selector?: string; x?: number; y?: number }): Promise<void> {
    this.ensure();
    if (opts.selector) await this.page.locator(opts.selector).scrollIntoViewIfNeeded();
    else await this.page.mouse.wheel(opts.x ?? 0, opts.y ?? 600);
  }
  async wait(ms: number): Promise<void> {
    this.ensure();
    await this.page.waitForTimeout(ms);
  }
  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    this.ensure();
    await this.page.waitForSelector(selector, { timeout: timeoutMs ?? this.defaultTimeout });
  }
  async screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array> {
    this.ensure();
    return this.page.screenshot({ fullPage: opts?.fullPage ?? false, type: 'png' });
  }
  async pdf(): Promise<Uint8Array> {
    this.ensure();
    return this.page.pdf();
  }
  async snapshot(): Promise<PageSnapshot> {
    this.ensure();
    const text: string = await this.page.evaluate('document.body ? document.body.innerText : ""');
    return { url: this.page.url(), title: await this.page.title(), text: text.slice(0, 4000) };
  }
  async extractText(selector?: string): Promise<string> {
    this.ensure();
    if (selector) return (await this.page.locator(selector).innerText()) as string;
    return (await this.page.evaluate('document.body ? document.body.innerText : ""')) as string;
  }
  async getHTML(selector?: string): Promise<string> {
    this.ensure();
    if (selector) return (await this.page.locator(selector).innerHTML()) as string;
    return (await this.page.content()) as string;
  }
  async evaluate(script: string): Promise<unknown> {
    this.ensure();
    return this.page.evaluate(script);
  }
  async getCookies(): Promise<BrowserCookie[]> {
    this.ensure();
    return (await this.context.cookies()) as BrowserCookie[];
  }
  async setCookies(cookies: BrowserCookie[]): Promise<void> {
    this.ensure();
    await this.context.addCookies(cookies);
  }
  async uploadFile(selector: string, files: UploadFile[]): Promise<void> {
    this.ensure();
    await this.page.setInputFiles(
      selector,
      files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) })),
    );
  }
  async download(): Promise<DownloadedFile | null> {
    this.ensure();
    const d = this.pendingDownload;
    if (!d) return null;
    this.pendingDownload = null;
    const stream = await d.createReadStream();
    if (!stream) return null;
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return { name: d.suggestedFilename(), mimeType: 'application/octet-stream', bytes: Buffer.concat(chunks) };
  }
  async getConsoleLogs(): Promise<ConsoleLog[]> {
    return [...this.consoleLogs];
  }
  async getNetworkRequests(): Promise<NetworkRequest[]> {
    return [...this.network];
  }
}

/** Import dinámico con especificador NO literal → sin dependencia dura de tipos ni resolución en build. */
export async function dynamicImport(specifier: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const spec = specifier;
  return import(spec);
}
