import type { DurableObjectNamespaceLike, HyperdriveLike, R2BucketLike } from '@core/infra/cloudflare';

/**
 * Bindings y variables del Worker del API. En Workers los recursos NO entran por URL sino por binding:
 * `env.HYPERDRIVE` ya lleva las credenciales de Postgres, `env.FILES` es el bucket. Por eso el bundle
 * se construye POR PETICIÓN a partir de `env` y no en un arranque global — en un isolate no hay
 * «arranque» al que colgar un singleton con estado de conexión.
 *
 * Las variables sí siguen llegando por `process.env` gracias a `nodejs_compat`, que las puebla desde
 * las vars y secrets del Worker; por eso `createLlmRouter()` y compañía funcionan sin tocarlos.
 */
export interface Env {
  /** Pool de conexiones a Postgres gestionado por Cloudflare. */
  HYPERDRIVE: HyperdriveLike;
  /** Bucket de ficheros efímeros de ejecución (M48). Su caducidad es una lifecycle rule, no código. */
  FILES: R2BucketLike;
  /** Un objeto por ejecución: checkpoint del contexto + fan-out del stream por WebSocket. */
  EXECUTION_ROOM: DurableObjectNamespaceLike;
  /** Un objeto por workspace: contador diario de tokens LLM (M33). */
  WORKSPACE_USAGE: DurableObjectNamespaceLike;

  /** Firma de las sesiones. Sin valor propio el Worker se niega a arrancar (igual que en Railway). */
  JWT_SECRET?: string;
  /** Clave maestra que cifra los tokens de conectores. DEBE coincidir con la de Railway. */
  KMS_MASTER_KEY?: string;
  /** URL pública del propio API (callbacks OAuth de conectores). */
  API_SELF_URL?: string;
  /** URL pública de la web (redirecciones tras el callback). */
  WEB_URL?: string;
}
