import type { BrowserConfig } from '../types';
import { PlaywrightBasedEngine, dynamicImport, type PlaywrightHandles } from './playwright-based-engine';

/**
 * Motor REAL con Playwright LOCAL (M71). Lanza Chromium en el propio proceso (requiere Playwright + Chromium
 * instalados — fase de infra propia). Playwright NO es dependencia dura: se importa de forma dinámica, así el
 * build/CI no lo necesita. Comparte toda la mecánica de página con `PlaywrightBasedEngine`; aquí sólo cambia
 * cómo se obtiene el navegador (launch local).
 */
export class PlaywrightBrowserEngine extends PlaywrightBasedEngine {
  readonly name = 'playwright' as const;

  protected async connect(config: BrowserConfig): Promise<PlaywrightHandles> {
    let pw;
    try {
      pw = await dynamicImport('playwright');
    } catch {
      throw new Error('El motor Playwright no está instalado en este entorno. Configura otro motor (p. ej. browserbase) o instálalo.');
    }
    const browser = await pw.chromium.launch({
      headless: config.headless ?? true,
      slowMo: config.slowMoMs,
      proxy: config.proxy ? { server: config.proxy } : undefined,
    });
    const context = await browser.newContext({
      viewport: config.viewport ?? { width: 1280, height: 800 },
      userAgent: config.userAgent,
      locale: config.locale,
      timezoneId: config.timezone,
    });
    const page = await context.newPage();
    return { browser, context, page };
  }
}
