import type { BrowserEngine, BrowserEngineName } from '../types';
import { MockBrowserEngine } from './mock-engine';
import { PlaywrightBrowserEngine } from './playwright-engine';
import { BrowserbaseBrowserEngine } from './browserbase-engine';

/**
 * Fábrica de MOTORES (M71) — el ÚNICO punto donde se decide qué motor se usa. Añadir Browserbase, Puppeteer,
 * Chrome DevTools o Browser Use en el futuro = registrar aquí su fábrica; nada más del sistema cambia, y los
 * workflows existentes siguen igual. La elección se hace por config (env `BROWSER_ENGINE`), nunca en el código
 * de las acciones ni de la tool. El usuario nunca sabe qué motor hay detrás.
 */
const REGISTRY: Partial<Record<BrowserEngineName, () => BrowserEngine>> = {
  mock: () => new MockBrowserEngine(),
  playwright: () => new PlaywrightBrowserEngine(), // Chromium local (fase de infra propia)
  browserbase: () => new BrowserbaseBrowserEngine(), // navegador remoto hospedado (sin Chromium propio)
  // puppeteer: () => new PuppeteerEngine(),          ← futuros motores, sin tocar el resto del sistema
  // 'chrome-devtools': () => new ChromeDevtoolsEngine(),
  // 'browser-use': () => new BrowserUseEngine(),
};

/** Motor por defecto: el configurado por env, o `mock` (nunca rompe si no hay navegador real disponible). */
export function defaultEngineName(): BrowserEngineName {
  const raw = (process.env.BROWSER_ENGINE ?? '').trim().toLowerCase();
  return (raw && raw in REGISTRY ? (raw as BrowserEngineName) : 'mock') as BrowserEngineName;
}

/** Crea una instancia de motor. Si el nombre no existe, cae a `mock` (degradación segura). */
export function createBrowserEngine(name: BrowserEngineName = defaultEngineName()): BrowserEngine {
  const make = REGISTRY[name] ?? REGISTRY.mock!;
  return make();
}

/** Nombres de motor registrados (para diagnóstico/tests). */
export function registeredEngines(): BrowserEngineName[] {
  return Object.keys(REGISTRY) as BrowserEngineName[];
}
