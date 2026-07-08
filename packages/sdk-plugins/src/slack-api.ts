/**
 * Slack API mínima (M57): lista los CANALES del workspace para poblar el desplegable «Canal» del nodo
 * conector (en vez de que el usuario escriba `#general` a mano). Puro, con `fetch` inyectable → testeable.
 * Se llama con el bot token del conector Slack conectado. Requiere `channels:read` (y `groups:read` para
 * los privados).
 */
export interface SlackChannel {
  id: string;
  name: string;
}

type Fetchish = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

interface ListResult {
  ok: boolean;
  error?: string;
  rows: Array<{ id?: string; name?: string }>;
}

/**
 * Devuelve los canales (públicos + privados en los que está el bot), no archivados, ordenados por nombre.
 * Pide ambos tipos; si al token le falta `groups:read` (Slack falla TODA la llamada con `missing_scope`),
 * REINTENTA solo con públicos → así funciona con o sin ese scope, sin romperse. En error de red/HTTP u
 * otro `ok:false` de Slack devuelve `[]` (el conector cae al campo de texto manual).
 */
export async function listSlackChannels(opts: { token: string; fetchFn?: Fetchish }): Promise<{ channels: SlackChannel[] }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const call = async (types: string): Promise<ListResult> => {
    const url = `https://slack.com/api/conversations.list?types=${types}&exclude_archived=true&limit=1000`;
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${opts.token}` } });
    if (!res.ok) return { ok: false, error: 'http', rows: [] };
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; channels?: Array<{ id?: string; name?: string }> };
    return { ok: !!data.ok, error: data.error, rows: data.channels ?? [] };
  };

  let r = await call('public_channel,private_channel');
  // Sin `groups:read`, pedir `private_channel` rompe la llamada entera → reintenta solo con públicos.
  if (!r.ok && r.error === 'missing_scope') r = await call('public_channel');
  if (!r.ok) return { channels: [] };

  const channels = r.rows
    .filter((c): c is { id: string; name: string } => !!c && !!c.id && !!c.name)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { channels };
}
