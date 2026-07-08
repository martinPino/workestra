import { z } from 'zod';

/**
 * Esquemas (Zod) de la configuración y de los parámetros de cada acción del navegador (M71). El tool valida
 * la entrada contra estos esquemas antes de tocar el motor → errores claros y seguridad de tipos.
 */

export const BrowserCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

export const BrowserConfigSchema = z.object({
  headless: z.boolean().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  proxy: z.string().optional(),
  cookies: z.array(BrowserCookieSchema).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  slowMoMs: z.number().int().nonnegative().max(5_000).optional(),
});
export type BrowserConfigInput = z.infer<typeof BrowserConfigSchema>;

/** Nombres de acción expuestos al agente (estilo MCP). Estables: cambiar el motor NO los cambia. */
export const BROWSER_ACTIONS = [
  'browser_open',
  'browser_close',
  'browser_goto',
  'browser_click',
  'browser_double_click',
  'browser_fill',
  'browser_type',
  'browser_press_key',
  'browser_wait',
  'browser_wait_for_selector',
  'browser_take_screenshot',
  'browser_generate_pdf',
  'browser_extract_text',
  'browser_get_html',
  'browser_execute_javascript',
  'browser_upload_file',
  'browser_download_file',
  'browser_get_console_logs',
  'browser_get_network_requests',
  'browser_get_cookies',
  'browser_set_cookies',
  'browser_scroll',
  'browser_hover',
  'browser_drag_drop',
  'browser_take_snapshot',
] as const;
export type BrowserActionName = (typeof BROWSER_ACTIONS)[number];

/** Referencia a un fichero del workspace (subidas): el motor lo resuelve a bytes al ejecutar. */
export const FileRefSchema = z.object({ fileId: z.string().min(1) });

/** Esquema de parámetros por acción. `sessionId` es obligatorio salvo en `browser_open`. */
export const ACTION_PARAM_SCHEMAS = {
  browser_open: z.object({ url: z.string().url().optional(), config: BrowserConfigSchema.optional() }),
  browser_close: z.object({ sessionId: z.string() }),
  browser_goto: z.object({ sessionId: z.string(), url: z.string().url() }),
  browser_click: z.object({ sessionId: z.string(), selector: z.string().min(1) }),
  browser_double_click: z.object({ sessionId: z.string(), selector: z.string().min(1) }),
  browser_fill: z.object({ sessionId: z.string(), selector: z.string().min(1), value: z.string() }),
  browser_type: z.object({ sessionId: z.string(), selector: z.string().min(1), text: z.string() }),
  browser_press_key: z.object({ sessionId: z.string(), key: z.string().min(1) }),
  browser_wait: z.object({ sessionId: z.string(), ms: z.number().int().nonnegative().max(60_000) }),
  browser_wait_for_selector: z.object({ sessionId: z.string(), selector: z.string().min(1), timeoutMs: z.number().int().positive().max(60_000).optional() }),
  browser_take_screenshot: z.object({ sessionId: z.string(), fullPage: z.boolean().optional() }),
  browser_generate_pdf: z.object({ sessionId: z.string() }),
  browser_extract_text: z.object({ sessionId: z.string(), selector: z.string().optional() }),
  browser_get_html: z.object({ sessionId: z.string(), selector: z.string().optional() }),
  browser_execute_javascript: z.object({ sessionId: z.string(), script: z.string().min(1) }),
  browser_upload_file: z.object({ sessionId: z.string(), selector: z.string().min(1), files: z.array(FileRefSchema).min(1) }),
  browser_download_file: z.object({ sessionId: z.string() }),
  browser_get_console_logs: z.object({ sessionId: z.string() }),
  browser_get_network_requests: z.object({ sessionId: z.string() }),
  browser_get_cookies: z.object({ sessionId: z.string() }),
  browser_set_cookies: z.object({ sessionId: z.string(), cookies: z.array(BrowserCookieSchema).min(1) }),
  browser_scroll: z.object({ sessionId: z.string(), selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
  browser_hover: z.object({ sessionId: z.string(), selector: z.string().min(1) }),
  browser_drag_drop: z.object({ sessionId: z.string(), from: z.string().min(1), to: z.string().min(1) }),
  browser_take_snapshot: z.object({ sessionId: z.string() }),
} as const satisfies Record<BrowserActionName, z.ZodTypeAny>;
