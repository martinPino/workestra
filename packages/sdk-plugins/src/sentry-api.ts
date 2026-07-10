/**
 * Sentry API (M79): helpers puros con `fetch` inyectable (testeables sin red) para el conector de primera
 * clase de Sentry. Sirven a tres capacidades:
 *  - `listSentryProjects`: puebla el desplegable de proyectos (como los canales de Slack / proyectos de Jira).
 *  - `pollSentryIssues`: el trigger «nuevo issue» SE SONDEA (como Google Drive): el cliente OAuth de Sentry es
 *    una OAuth Application pública (PKCE) y ese tipo NO puede registrar webhooks, así que se poll-ea la API.
 *  - `getSentryIssue` / `getSentryIssueLatestEvent`: los agentes leen el issue y su evento COMPLETO (stacktrace
 *    + breadcrumbs + contexto = «logs completos»), vía la integración de agente.
 * La base de la API es `https://sentry.io/api/0`. El `project` es el par «orgSlug/projectSlug» (identifica
 * inequívocamente un proyecto entre organizaciones).
 */
const SENTRY_API = 'https://sentry.io/api/0';

type Fetchish = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const auth = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/json' });

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

export interface SentryProject {
  /** Identificador «orgSlug/projectSlug» — se usa en las rutas /projects/{id}/…. */
  id: string;
  /** Nombre legible para el desplegable. */
  name: string;
}

/**
 * Lista los proyectos accesibles con el token (para el desplegable del trigger/acciones). Devuelve hasta 100,
 * ordenados por nombre. `id` es «orgSlug/projectSlug». En error devuelve [] (el llamante cae a input de texto).
 */
export async function listSentryProjects(opts: { token: string; fetchFn?: Fetchish }): Promise<{ projects: SentryProject[] }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const res = await fetchFn(`${SENTRY_API}/projects/?per_page=100`, { headers: auth(opts.token) });
  if (!res.ok) return { projects: [] };
  const data = await res.json().catch(() => []);
  const rows = Array.isArray(data) ? data : [];
  const projects = rows
    .map((r) => {
      const p = asRecord(r);
      const org = asRecord(p.organization);
      const orgSlug = String(org.slug ?? '');
      const slug = String(p.slug ?? '');
      if (!orgSlug || !slug) return null;
      return { id: `${orgSlug}/${slug}`, name: String(p.name ?? slug) };
    })
    .filter((p): p is SentryProject => !!p)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { projects };
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  permalink: string;
  firstSeen: string;
  count: string;
}

function toIssue(r: unknown): SentryIssue | null {
  const i = asRecord(r);
  const id = String(i.id ?? '');
  if (!id) return null;
  return {
    id,
    shortId: String(i.shortId ?? ''),
    title: String(i.title ?? '').slice(0, 200),
    culprit: String(i.culprit ?? '').slice(0, 200),
    level: String(i.level ?? ''),
    permalink: String(i.permalink ?? ''),
    firstSeen: String(i.firstSeen ?? ''),
    count: String(i.count ?? ''),
  };
}

/**
 * Sondea los issues NUEVOS de un proyecto (por `firstSeen`) desde `sinceIso`. `sort=new` (Sentry ordena por
 * primera vez visto). Devuelve los nuevos + `newSince` (el `firstSeen` máximo, o `sinceIso` si no hubo). Si la
 * llamada falla NO avanza el cursor (se reintenta el mismo lote). Mismo contrato que `pollDriveFiles`.
 */
export async function pollSentryIssues(opts: {
  token: string;
  project: string;
  sinceIso: string;
  fetchFn?: Fetchish;
}): Promise<{ issues: SentryIssue[]; newSince: string }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const url = `${SENTRY_API}/projects/${opts.project}/issues/?query=${encodeURIComponent('is:unresolved')}&sort=new&limit=25`;
  const res = await fetchFn(url, { headers: auth(opts.token) });
  if (!res.ok) return { issues: [], newSince: opts.sinceIso };
  const data = await res.json().catch(() => []);
  const rows = Array.isArray(data) ? data : [];
  const issues = rows
    .map(toIssue)
    .filter((i): i is SentryIssue => !!i && !!i.firstSeen && i.firstSeen > opts.sinceIso)
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)); // ascendente → dispara en orden de aparición
  const newSince = issues.reduce((max, i) => (i.firstSeen > max ? i.firstSeen : max), opts.sinceIso);
  return { issues, newSince };
}

/** Lee un issue de Sentry por id: título, nivel, culpable, contadores y permalink. `null`/error legible si falla. */
export async function getSentryIssue(opts: { token: string; issueId: string; fetchFn?: Fetchish }): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const res = await fetchFn(`${SENTRY_API}/issues/${encodeURIComponent(opts.issueId)}/`, { headers: auth(opts.token) });
  if (!res.ok) return { error: 'sentry_error', status: res.status };
  const i = asRecord(await res.json().catch(() => ({})));
  return {
    id: i.id,
    shortId: i.shortId,
    title: String(i.title ?? '').slice(0, 200),
    culprit: String(i.culprit ?? '').slice(0, 200),
    level: i.level,
    status: i.status,
    count: i.count,
    userCount: i.userCount,
    firstSeen: i.firstSeen,
    lastSeen: i.lastSeen,
    permalink: i.permalink,
    metadata: i.metadata,
  };
}

/** Aplana los frames de un stacktrace a texto acotado (para no reventar el contexto del modelo). */
function stackToText(entries: unknown[], cap = 2000): string {
  const lines: string[] = [];
  for (const e of entries) {
    const entry = asRecord(e);
    if (entry.type !== 'exception' && entry.type !== 'stacktrace') continue;
    const values = Array.isArray(asRecord(entry.data).values) ? (asRecord(entry.data).values as unknown[]) : [];
    for (const v of values) {
      const exc = asRecord(v);
      if (exc.type || exc.value) lines.push(`${String(exc.type ?? '')}: ${String(exc.value ?? '')}`.slice(0, 300));
      const frames = Array.isArray(asRecord(exc.stacktrace).frames) ? (asRecord(exc.stacktrace).frames as unknown[]) : [];
      for (const fr of frames.slice(-15)) {
        const f = asRecord(fr);
        lines.push(`  at ${String(f.function ?? '?')} (${String(f.filename ?? f.module ?? '?')}:${String(f.lineNo ?? '')})`);
      }
    }
  }
  return lines.join('\n').slice(0, cap);
}

/**
 * Devuelve el ÚLTIMO evento COMPLETO de un issue: mensaje, excepción + stacktrace aplanado, y breadcrumbs.
 * Esto es lo que un humano ve al abrir el issue en Sentry — «los logs completos» que pidió el usuario.
 */
export async function getSentryIssueLatestEvent(opts: { token: string; issueId: string; fetchFn?: Fetchish }): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const res = await fetchFn(`${SENTRY_API}/issues/${encodeURIComponent(opts.issueId)}/events/latest/`, { headers: auth(opts.token) });
  if (!res.ok) return { error: 'sentry_error', status: res.status };
  const ev = asRecord(await res.json().catch(() => ({})));
  const entries = Array.isArray(ev.entries) ? (ev.entries as unknown[]) : [];
  const breadcrumbEntry = entries.find((e) => asRecord(e).type === 'breadcrumbs');
  const crumbs = breadcrumbEntry ? (Array.isArray(asRecord(asRecord(breadcrumbEntry).data).values) ? (asRecord(asRecord(breadcrumbEntry).data).values as unknown[]) : []) : [];
  return {
    eventId: ev.eventID ?? ev.id,
    message: String(ev.message ?? ev.title ?? '').slice(0, 400),
    dateCreated: ev.dateCreated,
    platform: ev.platform,
    stacktrace: stackToText(entries),
    breadcrumbs: crumbs.slice(-20).map((c) => {
      const b = asRecord(c);
      return `${String(b.category ?? '')} ${String(b.level ?? '')}: ${String(b.message ?? '').slice(0, 160)}`.trim();
    }),
    tags: Array.isArray(ev.tags) ? (ev.tags as unknown[]).slice(0, 20).map((tt) => ({ key: asRecord(tt).key, value: asRecord(tt).value })) : [],
  };
}
