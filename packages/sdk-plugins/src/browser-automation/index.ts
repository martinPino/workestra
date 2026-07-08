/**
 * Browser Automation (M71) — módulo independiente y agnóstico del motor. El resto del sistema usa SÓLO estas
 * exportaciones; nunca importa Playwright ni ningún motor concreto. Fácil de extraer a `packages/browser-automation`.
 */
export * from './types';
export * from './schemas';
export * from './security';
export * from './session-manager';
export * from './service';
export { MockBrowserEngine } from './engines/mock-engine';
export { PlaywrightBrowserEngine } from './engines/playwright-engine';
export { BrowserbaseBrowserEngine } from './engines/browserbase-engine';
export { createBrowserEngine, defaultEngineName, registeredEngines } from './engines/factory';
