/**
 * Catálogo de proveedores de conectores (M11). Cada proveedor declara sus endpoints OAuth 2.0
 * (Authorization Code) y la base de API para el dispatch saliente. `dev` es un proveedor de
 * DESARROLLO servido por la propia API (flujo completo sin apps reales). Slack y Jira son
 * proveedores REALES: conectar exige registrar una app OAuth y configurar client id/secret por env
 * (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`, `JIRA_CLIENT_ID`/`JIRA_CLIENT_SECRET`).
 */
export interface ConnectorProvider {
  provider: string;
  label: string;
  /** Endpoint OAuth de autorización (Authorization Code). */
  authorizeUrl: string;
  /** Endpoint OAuth de intercambio de código por token. */
  tokenUrl: string;
  /** Base de API para las llamadas salientes del nodo de conector. */
  baseUrl: string;
  scopes: string[];
  /** Si es true, requiere client id/secret configurados (no conectable sin config). */
  requiresConfig: boolean;
  /** Formato del cuerpo del intercambio de token: JSON (Atlassian/dev) o form-urlencoded (Slack). */
  tokenExchange: 'json' | 'form';
  /** Ruta del access token en la respuesta del token endpoint (top-level por defecto). */
  tokenPath: string;
  /** Parámetros extra en la URL de autorización (p. ej. `audience`/`prompt` de Atlassian). */
  extraAuthorizeParams?: Record<string, string>;
}

/**
 * Construye el catálogo. `selfBase` es la URL de la propia API (donde vive el proveedor `dev`).
 */
export function connectorProviders(selfBase = 'http://localhost:3001'): Record<string, ConnectorProvider> {
  const base = selfBase.replace(/\/$/, '');
  return {
    dev: {
      provider: 'dev',
      label: 'Dev (mock)',
      authorizeUrl: `${base}/oauth/dev/authorize`,
      tokenUrl: `${base}/oauth/dev/token`,
      baseUrl: `${base}/oauth/dev/api`,
      scopes: ['read'],
      requiresConfig: false,
      tokenExchange: 'json',
      tokenPath: 'access_token',
    },
    slack: {
      provider: 'slack',
      label: 'Slack',
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      baseUrl: 'https://slack.com/api',
      scopes: ['chat:write', 'channels:read'],
      requiresConfig: true,
      tokenExchange: 'form', // Slack exige application/x-www-form-urlencoded en oauth.v2.access
      tokenPath: 'access_token', // token de bot (top-level)
    },
    jira: {
      provider: 'jira',
      label: 'Jira',
      authorizeUrl: 'https://auth.atlassian.com/authorize',
      tokenUrl: 'https://auth.atlassian.com/oauth/token',
      // Base de Atlassian; el nodo debe apuntar a /ex/jira/{cloudid}/rest/api/3/… (ver docs).
      baseUrl: 'https://api.atlassian.com',
      scopes: ['read:jira-work', 'write:jira-work', 'offline_access'],
      requiresConfig: true,
      tokenExchange: 'json',
      tokenPath: 'access_token',
      extraAuthorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    },
    github: {
      provider: 'github',
      label: 'GitHub',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      baseUrl: 'https://api.github.com',
      scopes: ['repo'],
      requiresConfig: true,
      tokenExchange: 'form',
      tokenPath: 'access_token',
    },
  };
}

export function getConnectorProvider(provider: string, selfBase?: string): ConnectorProvider | null {
  return connectorProviders(selfBase)[provider] ?? null;
}

/** Nombre de las env vars con las credenciales del cliente OAuth de un proveedor. */
export function providerEnvKeys(provider: string): { id: string; secret: string } {
  const P = provider.toUpperCase();
  return { id: `${P}_CLIENT_ID`, secret: `${P}_CLIENT_SECRET` };
}
