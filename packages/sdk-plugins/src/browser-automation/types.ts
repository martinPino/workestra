/**
 * Browser Automation — contratos del MOTOR (M71). Todo el sistema depende ÚNICAMENTE de `BrowserEngine`,
 * nunca de Playwright/Puppeteer/etc. directamente. Cambiar de motor (Playwright → Browserbase → Puppeteer →
 * Chrome DevTools → Browser Use) es cambiar la fábrica de motores, sin tocar acciones, tools ni workflows.
 * El usuario nunca sabe qué motor se usa.
 */

/** Motores soportables. Añadir uno nuevo = registrar su fábrica en `engines/factory.ts`. */
export type BrowserEngineName = 'mock' | 'playwright' | 'browserbase' | 'puppeteer' | 'chrome-devtools' | 'browser-use';

/** Configuración de una sesión de navegador (todo opcional; el motor aplica sus defaults). */
export interface BrowserConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  /** Proxy en formato `http://user:pass@host:port` (o sin credenciales). */
  proxy?: string;
  cookies?: BrowserCookie[];
  /** Timeout por defecto de las acciones, en ms. */
  timeoutMs?: number;
  /** Ralentiza cada acción (ms) para depurar visualmente (como el slowMo de Playwright). */
  slowMoMs?: number;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface UploadFile {
  name: string;
  mimeType: string;
  /** Bytes del fichero a subir. */
  bytes: Uint8Array;
}

export interface ConsoleLog {
  level: string; // 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string;
  at: string; // ISO
}

export interface NetworkRequest {
  url: string;
  method: string;
  status?: number;
  ok?: boolean;
  resourceType?: string;
}

export interface DownloadedFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Texto visible resumido (para que el agente «vea» la página sin bytes). */
  text: string;
}

/**
 * MOTOR de navegador. Cada instancia gestiona UNA sesión (un navegador + contexto + página). El resto del
 * sistema (acciones, tool, servicio) sólo conoce esta interfaz. Implementaciones: MockBrowserEngine (por
 * defecto, sin Chromium; sirve para tests/CI), PlaywrightBrowserEngine (real, opcional), etc.
 */
export interface BrowserEngine {
  readonly name: BrowserEngineName;
  /** true sólo si el motor puede controlar un navegador REAL en este entorno (Mock = false). */
  readonly live: boolean;

  launch(config: BrowserConfig): Promise<void>;
  close(): Promise<void>;

  goto(url: string): Promise<{ url: string; status?: number }>;
  click(selector: string): Promise<void>;
  doubleClick(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  hover(selector: string): Promise<void>;
  dragAndDrop(from: string, to: string): Promise<void>;
  scroll(opts: { selector?: string; x?: number; y?: number }): Promise<void>;

  wait(ms: number): Promise<void>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;

  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  pdf(): Promise<Uint8Array>;
  snapshot(): Promise<PageSnapshot>;

  extractText(selector?: string): Promise<string>;
  getHTML(selector?: string): Promise<string>;
  evaluate(script: string): Promise<unknown>;

  getCookies(): Promise<BrowserCookie[]>;
  setCookies(cookies: BrowserCookie[]): Promise<void>;

  uploadFile(selector: string, files: UploadFile[]): Promise<void>;
  download(): Promise<DownloadedFile | null>;

  getConsoleLogs(): Promise<ConsoleLog[]>;
  getNetworkRequests(): Promise<NetworkRequest[]>;
}
