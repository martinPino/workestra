/**
 * Slack API mínima (M57): lista los CANALES del workspace para poblar el desplegable «Canal» del nodo
 * conector (en vez de que el usuario escriba `#general` a mano). Puro, con `fetch` inyectable → testeable.
 * Se llama con el bot token del conector Slack conectado. Requiere los scopes `channels:read`/`groups:read`.
 */
export interface SlackChannel {
  id: string;
  name: string;
}

type Fetchish = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Devuelve los canales (públicos + privados en los que está el bot), no archivados, ordenados por nombre.
 * En error de red/HTTP o `ok:false` de Slack (p. ej. `missing_scope`) devuelve `[]` — el conector cae al
 * campo de texto manual.
 */
export async function listSlackChannels(opts: { token: string; fetchFn?: Fetchish }): Promise<{ channels: SlackChannel[] }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  // Solo canales PÚBLICOS: bastan `channels:read` (los privados exigirían además `groups:read`, que no
  // pedimos; pedir `private_channel` sin ese scope haría fallar TODA la llamada con `missing_scope`).
  const url = 'https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=1000';
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${opts.token}` } });
  if (!res.ok) return { channels: [] };
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; channels?: Array<{ id?: string; name?: string }> };
  if (!data.ok) return { channels: [] };
  const channels = (data.channels ?? [])
    .filter((c): c is { id: string; name: string } => !!c && !!c.id && !!c.name)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { channels };
}
