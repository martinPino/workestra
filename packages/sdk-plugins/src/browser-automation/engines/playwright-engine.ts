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
 * Motor REAL con Playwright (M71). Playwright NO es dependencia dura del paquete: se importa de forma
 * DINÁMICA (especificador variable → TypeScript no lo resuelve, `any`), así el build/CI no lo necesita.
 * En producción, cuando se instala `playwright` + Chromium (fase de infra) y `BROWSER_ENGINE=playwright`,
 * este motor pasa a controlar un navegador de verdad — sin tocar acciones, tool ni workflows.
 */
export class PlaywrightBrowserEngine implements BrowserEngine {
  readonly name = 'playwright' as const;
  readonly live = true;

  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private readonly consoleLogs: ConsoleLog[] = [];
  private readonly network: NetworkRequest[] = [];
  private pendingDownload: any = null;
  private defaultTimeout = 30_000;

  private ensure() {
    if (!this.page) throw new Error('El navegador no está abierto (llama a browser_open primero).');
  }

  async launch(config: BrowserConfig): Promise<void> {
    // Import dinámico con especificador NO literal → sin dependencia dura ni resolución de tipos.
    const specifier = 'playwright';
    let pw: any;
    try {
      pw = await import(specifier);
    } catch {
      throw new Error('El motor Playwright no está instalado en este entorno. Configura otro motor o instálalo.');
    }
    this.defaultTimeout = config.timeoutMs ?? 30_000;
    this.browser = await pw.chromium.launch({
      headless: config.headless ?? true,
      slowMo: config.slowMoMs,
      proxy: config.proxy ? { server: config.proxy } : undefined,
    });
    this.context = await this.browser.newContext({
      viewport: config.viewport ?? { width: 1280, height: 800 },
      userAgent: config.userAgent,
      locale: config.locale,
      timezoneId: config.timezone,
    });
    this.context.setDefaultTimeout(this.defaultTimeout);
    if (config.cookies?.length) await this.context.addCookies(config.cookies);
    this.page = await this.context.newPage();
    this.page.on('console', (m: any) => this.consoleLogs.push({ level: m.type(), text: m.text(), at: new Date().toISOString() }));
    this.page.on('response', (r: any) => this.network.push({ url: r.url(), method: r.request().method(), status: r.status(), ok: r.ok(), resourceType: r.request().resourceType() }));
    this.page.on('download', (d: any) => {
      this.pendingDownload = d;
    });
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
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
