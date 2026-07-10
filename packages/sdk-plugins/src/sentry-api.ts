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
import { createHmac, timingSafeEqual } from 'node:crypto';

const SENTRY_API = 'https://sentry.io/api/0';

/** URL de instalación de la Sentry App (Public Integration) para que una org instale Workestra. */
export function sentryAppInstallUrl(slug: string): string {
  return `https://sentry.io/sentry-apps/${encodeURIComponent(slug)}/external-install/`;
}

/**
 * Autoriza una instalación de la Sentry App: intercambia el `code` (que Sentry devuelve tras instalar) por un
 * token en `/sentry-app-installations/{id}/authorizations/`. Confirma que la instalación es legítima. Server-side.
 */
export async function exchangeSentryAppCode(opts: {
  installationId: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ ok: boolean; token?: string; status: number }> {
  const res = await fetch(`${SENTRY_API}/sentry-app-installations/${encodeURIComponent(opts.installationId)}/authorizations/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: opts.code, client_id: opts.clientId, client_secret: opts.clientSecret }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, token: typeof body.token === 'string' ? body.token : undefined, status: res.status };
}

/**
 * Verifica la firma de un webhook de Sentry (`Sentry-Hook-Signature`): HMAC-SHA256 del cuerpo CRUDO con el
 * Client Secret de la integración, en hex. Comparación en tiempo constante. `false` ante cualquier duda.
 */
export function verifySentryWebhookSignature(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SentryWebhookIssue {
  action: string; // created | resolved | assigned | archived | unresolved
  /** «orgSlug/projectSlug» derivado del payload (para enrutar contra los trigger bindings). */
  project: string | null;
  issue: {
    id: string;
    shortId: string;
    title: string;
    culprit: string;
    level: string;
    permalink: string;
    projectSlug: string;
    firstSeen: string;
  };
}

/** Extrae orgSlug de las URLs del issue (`/organizations/{org}/…` o `{org}.sentry.io`). `null` si no se puede. */
function orgFromUrls(...urls: unknown[]): string | null {
  for (const u of urls) {
    const s = String(u ?? '');
    const m1 = s.match(/\/organizations\/([^/]+)/);
    if (m1) return m1[1];
    const m2 = s.match(/https?:\/\/([^./]+)\.sentry\.io/);
    if (m2 && m2[1] !== 'www') return m2[1];
  }
  return null;
}

/** Parsea el webhook de recurso `issue` de Sentry a un shape estable + el `org/proyecto` para enrutar. */
export function parseSentryIssueWebhook(payload: unknown): SentryWebhookIssue {
  const p = asRecord(payload);
  const issue = asRecord(asRecord(p.data).issue);
  const project = asRecord(issue.project);
  const projectSlug = String(project.slug ?? '');
  const org = orgFromUrls(issue.web_url, issue.permalink, project.slug && issue.project_url);
  return {
    action: String(p.action ?? ''),
    project: org && projectSlug ? `${org}/${projectSlug}` : null,
    issue: {
      id: String(issue.id ?? ''),
      shortId: String(issue.shortId ?? ''),
      title: String(issue.title ?? '').slice(0, 300),
      culprit: String(issue.culprit ?? '').slice(0, 300),
      level: String(issue.level ?? ''),
      permalink: String(issue.web_url ?? issue.permalink ?? ''),
      projectSlug,
      firstSeen: String(issue.firstSeen ?? ''),
    },
  };
}

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

/** Base de API de una org según su región (Sentry es MULTI-REGIÓN: la UE va por `de.sentry.io`, no `sentry.io`). */
function regionApi(regionUrl: string | undefined): string {
  const base = (regionUrl ?? '').replace(/\/$/, '');
  return base ? `${base}/api/0` : SENTRY_API;
}

/**
 * Lista los proyectos accesibles con el token (para el desplegable del trigger/acciones). `id` es
 * «orgSlug/projectSlug». MULTI-REGIÓN: descubre las orgs en el silo de control (`sentry.io`) con su `regionUrl`
 * y lista los proyectos EN LA REGIÓN de cada org — si no, una org de la UE saldría vacía. En error devuelve [].
 */
export async function listSentryProjects(opts: { token: string; fetchFn?: Fetchish }): Promise<{ projects: SentryProject[] }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const orgsRes = await fetchFn(`${SENTRY_API}/organizations/?per_page=100`, { headers: auth(opts.token) });
  if (!orgsRes.ok) return { projects: [] };
  const orgs = await orgsRes.json().catch(() => []);
  const orgRows = Array.isArray(orgs) ? orgs : [];
  const projects: SentryProject[] = [];
  const seen = new Set<string>();
  for (const o of orgRows) {
    const org = asRecord(o);
    const orgSlug = String(org.slug ?? '');
    if (!orgSlug) continue;
    const regionUrl = String(asRecord(org.links).regionUrl ?? '');
    const res = await fetchFn(`${regionApi(regionUrl)}/organizations/${encodeURIComponent(orgSlug)}/projects/?per_page=100`, { headers: auth(opts.token) });
    if (!res.ok) continue;
    const rows = await res.json().catch(() => []);
    for (const r of Array.isArray(rows) ? rows : []) {
      const p = asRecord(r);
      const slug = String(p.slug ?? '');
      const id = `${orgSlug}/${slug}`;
      if (slug && !seen.has(id)) {
        seen.add(id);
        projects.push({ id, name: String(p.name ?? slug) });
      }
    }
  }
  return { projects: projects.sort((a, b) => a.name.localeCompare(b.name)) };
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
/** Base de API de un org por su slug, resolviendo la REGIÓN (UE → de.sentry.io). Cae a sentry.io si no la sabe. */
export async function sentryOrgApiBase(token: string, orgSlug: string, fetchFn?: Fetchish): Promise<string> {
  const f = fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const res = await f(`${SENTRY_API}/organizations/${encodeURIComponent(orgSlug)}/`, { headers: auth(token) });
  if (!res.ok) return SENTRY_API;
  const org = asRecord(await res.json().catch(() => ({})));
  return regionApi(String(asRecord(org.links).regionUrl ?? ''));
}

export async function pollSentryIssues(opts: {
  token: string;
  project: string;
  sinceIso: string;
  fetchFn?: Fetchish;
}): Promise<{ issues: SentryIssue[]; newSince: string }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  // MULTI-REGIÓN: un org de la UE lista issues en de.sentry.io, no sentry.io.
  const base = await sentryOrgApiBase(opts.token, opts.project.split('/')[0], fetchFn);
  const url = `${base}/projects/${opts.project}/issues/?query=${encodeURIComponent('is:unresolved')}&sort=new&limit=25`;
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
