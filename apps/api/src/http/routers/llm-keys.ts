import { Hono } from 'hono';
import { requireScopes } from '../scopes.middleware';
import { ws, type RouterEnv } from './types';

/**
 * Claves de IA propias del workspace (BYOK, M35): port de `LlmKeysController`.
 *
 * Los scopes son ASIMÉTRICOS a propósito y hay que conservarlo: listarlas (enmascaradas) va con
 * `workflow:read`, pero añadir o quitar una es gestión de credenciales compartidas del espacio →
 * `apikey:manage` (ADMIN/OWNER), no EDITOR.
 */
export function llmKeysRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.get('/', requireScopes('workflow:read'), async (c) => c.json(await c.get('services').llmKeys.list(ws(c))));

  r.post('/', requireScopes('apikey:manage'), async (c) => {
    const b = await c.req.json<{ provider?: string; apiKey?: string }>();
    return c.json(await c.get('services').llmKeys.set(ws(c), b?.provider ?? '', b?.apiKey ?? ''));
  });

  r.delete('/:provider', requireScopes('apikey:manage'), async (c) =>
    c.json(await c.get('services').llmKeys.remove(ws(c), c.req.param('provider'))),
  );

  return r;
}
