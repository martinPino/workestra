/**
 * Protocolo interno entre los adaptadores de `@core/infra/cloudflare` (lado cliente) y las clases
 * Durable Object que los sirven (lado servidor, en `apps/api`). Se habla por `fetch` sobre el stub del DO
 * en vez de por RPC para que el core NO tenga que importar las clases del Worker — un DO es código de la
 * app, un adaptador es infraestructura, y la dependencia solo puede ir en ese sentido.
 *
 * El host `do.invalid` no se resuelve nunca: `stub.fetch` enruta al objeto por el binding, no por DNS.
 * Se usa un dominio del TLD reservado para que una fuga accidental a la red real falle en vez de acertar.
 */

const BASE = 'https://do.invalid';

/** Rutas del DO `ExecutionRoom` (uno por ejecución): checkpoint del contexto + fan-out del stream. */
export const EXECUTION_ROOM = {
  /** GET → `ExecutionContext` (200) o 404 si la ejecución aún no ha checkpointeado nada. */
  context: `${BASE}/context`,
  /** POST `ExecutionContext` → 204. Sobrescribe el checkpoint. */
  checkpoint: `${BASE}/context`,
  /** POST `ExecutionEvent` → 204. Difunde a los WebSocket suscritos a esta ejecución. */
  publish: `${BASE}/events`,
  /** GET con `Upgrade: websocket` → 101. Lo sirve el Worker, no estos adaptadores. */
  websocket: `${BASE}/ws`,
} as const;

/** Rutas del DO `WorkspaceUsage` (uno por workspace): contador diario de tokens LLM. */
export const WORKSPACE_USAGE = {
  /** POST `{ tokens, day }` → `{ total }`. */
  add: `${BASE}/add`,
  /** GET `?day=AAAA-MM-DD` → `{ total }`. */
  today: `${BASE}/today`,
} as const;

/** Nombre del DO de una ejecución. Estable: el mismo id resuelve siempre al mismo objeto. */
export const executionRoomName = (executionId: string): string => `exec:${executionId}`;

/** Nombre del DO de uso de un workspace. */
export const workspaceUsageName = (workspaceId: string): string => `usage:${workspaceId}`;

/**
 * Ventana diaria en UTC (AAAA-MM-DD), igual que el adaptador de Redis. La calcula el CLIENTE y la manda
 * al DO: un Durable Object puede vivir en cualquier región, y dejarle decidir «hoy» haría que la cuota
 * se resetease a horas distintas según dónde se instanciara.
 */
export const dayKey = (now: Date = new Date()): string => now.toISOString().slice(0, 10);
