import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { connectorProviders } from '@core/sdk-plugins';
import { UnauthorizedException } from '../common';
import { requireScopes } from '../scopes.middleware';
import { ws, type RouterEnv } from './types';

/**
 * Conectores OAuth (M11): port de `ConnectorsController`.
 *
 * Los scopes son de ADMIN (`connector:write` / `connector:delete`) para todo lo que toque credenciales;
 * los listados de recursos del proveedor (carpetas de Drive, canales de Slack…) van con `workflow:read`
 * porque solo alimentan desplegables del editor. Conservar esa asimetría es lo importante del port.
 */
export function connectorsRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  /**
   * Callback OAuth (PÚBLICO): el proveedor redirige aquí con `code` + `state`. Va ANTES que `/:id/...`
   * porque `callback` es un literal que si no acabaría casando como un id de conector.
   */
  r.get('/callback', async (c) => {
    const { redirectTo } = await c.get('services').connectors.callback(c.req.query('code')!, c.req.query('state')!);
    return c.redirect(redirectTo);
  });

  /** Callback de instalación de la Sentry App (M80, PÚBLICO). */
  r.get('/sentry-app/callback', async (c) => {
    const { redirectTo } = await c
      .get('services')
      .connectors.sentryAppCallback(c.req.query('installationId')!, c.req.query('code')!);
    return c.redirect(redirectTo);
  });

  r.get('/providers', requireScopes('workflow:read'), (c) => {
    const isProd = process.env.NODE_ENV === 'production';
    const svc = c.get('services').connectors;
    return c.json(
      Object.values(connectorProviders())
        .filter((p) => p.provider !== 'dev' || !isProd) // el proveedor dev no existe en prod
        .map((p) => ({
          provider: p.provider,
          label: p.label,
          scopes: p.scopes,
          requiresConfig: p.requiresConfig,
          configured: svc.isConfigured(p.provider),
          configProvider: p.configProvider ?? p.provider,
          pkce: p.pkce ?? false,
        })),
    );
  });

  r.get('/', requireScopes('workflow:read'), async (c) => c.json(await c.get('services').connectors.list(ws(c))));

  r.post('/', requireScopes('connector:write'), async (c) => {
    const b = await c.req.json<{ provider?: string; key?: string }>();
    return c.json(await c.get('services').connectors.create(ws(c), b?.provider ?? '', b?.key ?? ''));
  });

  r.post('/:id/connect', requireScopes('connector:write'), async (c) =>
    c.json(await c.get('services').connectors.connect(c.req.param('id'), ws(c))),
  );

  // Listados que alimentan los desplegables del editor: lectura, no gestión de credenciales.
  r.get('/:id/drive-folders', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').connectors.driveFolders(c.req.param('id'), ws(c))),
  );
  r.get('/:id/slack-channels', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').connectors.slackChannels(c.req.param('id'), ws(c))),
  );
  r.get('/:id/sentry-projects', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').connectors.sentryProjects(c.req.param('id'), ws(c))),
  );
  r.get('/:id/github-repos', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').connectors.githubRepos(c.req.param('id'), ws(c))),
  );

  r.delete('/:id', requireScopes('connector:delete'), async (c) =>
    c.json(await c.get('services').connectors.delete(c.req.param('id'), ws(c))),
  );

  return r;
}

/**
 * Proveedor OAuth de DESARROLLO servido por la propia API: simula Authorization Code para probar el
 * flujo completo sin apps OAuth reales. Auto-aprueba y emite tokens sin verificar identidad, así que
 * **no debe montarse en producción** — `worker.ts` lo condiciona a `NODE_ENV !== 'production'`.
 */
export function devOAuthRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.get('/authorize', (c) => {
    const redirectUri = c.req.query('redirect_uri') ?? '';
    const state = c.req.query('state') ?? '';
    const code = `devcode_${randomBytes(8).toString('hex')}`;
    const sep = redirectUri.includes('?') ? '&' : '?';
    return c.redirect(`${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  });

  r.post('/token', async (c) => {
    const b = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
    if (!b?.code) throw new UnauthorizedException('Falta code.');
    return c.json({ access_token: `devtok_${randomBytes(12).toString('hex')}`, token_type: 'bearer', scope: 'read' });
  });

  r.get('/api/whoami', (c) => {
    // Valida el Bearer pero NO refleja material del token en la respuesta (evita que fragmentos del
    // token acaben en el bodyPreview persistido del nodo de conector).
    const auth = c.req.header('authorization');
    if (!auth?.startsWith('Bearer ') || auth.length < 12) throw new UnauthorizedException('Falta Bearer.');
    return c.json({ ok: true, user: 'dev-user', at: 'dev-provider' });
  });

  return r;
}
