/**
 * INTEGRACIONES de primera clase (M76): una «integración» expone capacidades de un proveedor (Jira,
 * Confluence…) a los agentes COMO HERRAMIENTAS, mientras la plataforma es dueña del OAuth. El agente nunca
 * ve el token ni sabe de OAuth: declara que usa la integración (una ref MCP `integration://<key>`) y el
 * `IntegrationToolResolver` resuelve el conector OAuth del workspace, obtiene/renueva el token y lo inyecta
 * en cada `run` al llamar a la API REST del proveedor. Es AGNÓSTICO de proveedor: añadir otra integración es
 * añadir una entrada aquí; y agnóstico de transporte: hoy cumplimos vía REST, mañana podría ser el MCP
 * remoto de Atlassian sin tocar agentes ni plantillas.
 */
import type { JiraFetch } from './jira-webhooks';

/** Contexto que el resolver inyecta a cada herramienta: token (dueño la plataforma) + cloudId + fetch. */
export interface IntegrationToolCtx {
  token: string;
  cloudId: string;
  fetch: JiraFetch;
}

/** Una capacidad concreta ofrecida al modelo: nombre + descripción + esquema JSON + ejecución REST. */
export interface IntegrationToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: IntegrationToolCtx): Promise<unknown>;
}

/** Una integración = un conjunto de herramientas respaldadas por UN conector OAuth (por `provider`). */
export interface IntegrationDef {
  key: string;
  label: string;
  /** Clave del proveedor de conector (`connector-providers.ts`) que aporta el OAuth: Atlassian → `jira`. */
  provider: string;
  tools: IntegrationToolDef[];
}

export const INTEGRATION_URL_PREFIX = 'integration://';

/** Ref MCP sentinela que declara una integración en `agent.mcpServers` (sin token aparte). */
export function integrationUrl(key: string): string {
  return `${INTEGRATION_URL_PREFIX}${key}`;
}

/** Extrae la clave de integración de una URL `integration://atlassian`; `null` si no lo es. */
export function integrationKeyFromUrl(url: string): string | null {
  if (!url.startsWith(INTEGRATION_URL_PREFIX)) return null;
  const key = url.slice(INTEGRATION_URL_PREFIX.length).replace(/\/+$/, '').trim();
  return key || null;
}

const ATLASSIAN_API = 'https://api.atlassian.com';
const jiraApi = (cloudId: string) => `${ATLASSIAN_API}/ex/jira/${cloudId}/rest/api/3`;
const confluenceApi = (cloudId: string) => `${ATLASSIAN_API}/ex/confluence/${cloudId}/wiki/rest/api`;

const jsonHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json',
});

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

/** Texto plano → documento ADF mínimo (formato de Jira Cloud v3 para descripción/comentario). */
function adf(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text || ' ') }] }],
  };
}

/** Aplana un doc ADF/nodo Confluence a texto legible y ACOTADO (los resultados de tool se truncan). */
function adfToText(node: unknown, cap = 280): string {
  const walk = (n: unknown): string => {
    const r = asRecord(n);
    if (typeof r.text === 'string') return r.text;
    const kids = Array.isArray(r.content) ? r.content : [];
    return kids.map(walk).join('');
  };
  return walk(node).replace(/\s+/g, ' ').trim().slice(0, cap);
}

async function readJson(res: { ok: boolean; status: number; json: () => Promise<unknown> }): Promise<{ ok: boolean; status: number; body: unknown }> {
  let body: unknown = undefined;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { ok: res.ok, status: res.status, body };
}

function fail(status: number, body: unknown): { error: string; status: number; detail: string } {
  const r = asRecord(body);
  const msgs = Array.isArray(r.errorMessages) ? r.errorMessages : [];
  const errs = r.errors ? Object.values(asRecord(r.errors)) : [];
  const detail = [...msgs, ...errs].filter(Boolean).join('; ') || String(r.message ?? '').slice(0, 160) || `HTTP ${status}`;
  return { error: 'atlassian_error', status, detail: detail.slice(0, 200) };
}

const clampInt = (v: unknown, def: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
};

// --- Herramientas Jira (base /ex/jira/{cloudId}/rest/api/3) --------------------------------------------

const JIRA_TOOLS: IntegrationToolDef[] = [
  {
    name: 'jira_search_issues',
    description: 'Busca incidencias de Jira con JQL (p. ej. "project = KAN AND status = \'To Do\'"). Devuelve clave, resumen y estado.',
    parameters: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'Consulta JQL de Jira.' },
        maxResults: { type: 'number', description: 'Máximo de resultados (por defecto 10, máx 25).' },
      },
      required: ['jql'],
    },
    async run(args, ctx) {
      const jql = String(args.jql ?? '').trim();
      if (!jql) return { error: 'invalid_args', detail: 'jql es obligatorio.' };
      const maxResults = clampInt(args.maxResults, 10, 25);
      const res = await ctx.fetch(`${jiraApi(ctx.cloudId)}/search`, {
        method: 'POST',
        headers: jsonHeaders(ctx.token),
        body: JSON.stringify({ jql, maxResults, fields: ['summary', 'status', 'assignee', 'issuetype'] }),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      const issues = Array.isArray(asRecord(body).issues) ? (asRecord(body).issues as unknown[]) : [];
      return {
        total: asRecord(body).total ?? issues.length,
        issues: issues.map((it) => {
          const f = asRecord(asRecord(it).fields);
          return {
            key: asRecord(it).key,
            summary: String(f.summary ?? '').slice(0, 120),
            status: asRecord(f.status).name,
            assignee: asRecord(f.assignee).displayName ?? null,
          };
        }),
      };
    },
  },
  {
    name: 'jira_get_issue',
    description: 'Lee una incidencia de Jira por su clave (p. ej. "KAN-12"): resumen, estado, asignado y descripción.',
    parameters: {
      type: 'object',
      properties: { issueKey: { type: 'string', description: 'Clave de la incidencia, p. ej. KAN-12.' } },
      required: ['issueKey'],
    },
    async run(args, ctx) {
      const key = String(args.issueKey ?? '').trim();
      if (!key) return { error: 'invalid_args', detail: 'issueKey es obligatorio.' };
      const res = await ctx.fetch(`${jiraApi(ctx.cloudId)}/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,description,issuetype,priority`, {
        headers: jsonHeaders(ctx.token),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      const f = asRecord(asRecord(body).fields);
      return {
        key: asRecord(body).key,
        summary: String(f.summary ?? '').slice(0, 160),
        status: asRecord(f.status).name,
        type: asRecord(f.issuetype).name,
        priority: asRecord(f.priority).name ?? null,
        assignee: asRecord(f.assignee).displayName ?? null,
        description: adfToText(f.description),
      };
    },
  },
  {
    name: 'jira_create_issue',
    description: 'Crea una incidencia en Jira en el proyecto dado. Devuelve la clave creada.',
    parameters: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'Clave del proyecto, p. ej. KAN.' },
        summary: { type: 'string', description: 'Título de la incidencia.' },
        issueType: { type: 'string', description: 'Tipo (por defecto "Task").' },
        description: { type: 'string', description: 'Descripción en texto plano (opcional).' },
      },
      required: ['projectKey', 'summary'],
    },
    async run(args, ctx) {
      const projectKey = String(args.projectKey ?? '').trim();
      const summary = String(args.summary ?? '').trim();
      if (!projectKey || !summary) return { error: 'invalid_args', detail: 'projectKey y summary son obligatorios.' };
      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary,
        issuetype: { name: String(args.issueType ?? 'Task') },
      };
      if (args.description) fields.description = adf(String(args.description));
      const res = await ctx.fetch(`${jiraApi(ctx.cloudId)}/issue`, {
        method: 'POST',
        headers: jsonHeaders(ctx.token),
        body: JSON.stringify({ fields }),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      return { created: true, key: asRecord(body).key, id: asRecord(body).id };
    },
  },
  {
    name: 'jira_add_comment',
    description: 'Añade un comentario a una incidencia de Jira.',
    parameters: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Clave de la incidencia.' },
        comment: { type: 'string', description: 'Texto del comentario.' },
      },
      required: ['issueKey', 'comment'],
    },
    async run(args, ctx) {
      const key = String(args.issueKey ?? '').trim();
      const comment = String(args.comment ?? '').trim();
      if (!key || !comment) return { error: 'invalid_args', detail: 'issueKey y comment son obligatorios.' };
      const res = await ctx.fetch(`${jiraApi(ctx.cloudId)}/issue/${encodeURIComponent(key)}/comment`, {
        method: 'POST',
        headers: jsonHeaders(ctx.token),
        body: JSON.stringify({ body: adf(comment) }),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      return { added: true, id: asRecord(body).id };
    },
  },
  {
    name: 'jira_transition_issue',
    description: 'Cambia el estado de una incidencia de Jira (p. ej. a "Done"). Acepta el nombre o el id de la transición.',
    parameters: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'Clave de la incidencia.' },
        transition: { type: 'string', description: 'Nombre (p. ej. "Done") o id de la transición.' },
      },
      required: ['issueKey', 'transition'],
    },
    async run(args, ctx) {
      const key = String(args.issueKey ?? '').trim();
      const wanted = String(args.transition ?? '').trim();
      if (!key || !wanted) return { error: 'invalid_args', detail: 'issueKey y transition son obligatorios.' };
      // Resuelve nombre→id: lista las transiciones válidas desde el estado actual.
      const listRes = await ctx.fetch(`${jiraApi(ctx.cloudId)}/issue/${encodeURIComponent(key)}/transitions`, {
        headers: jsonHeaders(ctx.token),
      });
      const listed = await readJson(listRes);
      if (!listed.ok) return fail(listed.status, listed.body);
      const transitions = Array.isArray(asRecord(listed.body).transitions) ? (asRecord(listed.body).transitions as unknown[]) : [];
      const match = transitions.find((t) => {
        const r = asRecord(t);
        return String(r.id) === wanted || String(r.name ?? '').toLowerCase() === wanted.toLowerCase();
      });
      if (!match) {
        const names = transitions.map((t) => asRecord(t).name).filter(Boolean);
        return { error: 'transition_not_found', detail: `Transiciones válidas: ${names.join(', ').slice(0, 160)}` };
      }
      const res = await ctx.fetch(`${jiraApi(ctx.cloudId)}/issue/${encodeURIComponent(key)}/transitions`, {
        method: 'POST',
        headers: jsonHeaders(ctx.token),
        body: JSON.stringify({ transition: { id: asRecord(match).id } }),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      return { transitioned: true, to: asRecord(match).name };
    },
  },
];

// --- Herramientas Confluence (base /ex/confluence/{cloudId}/wiki/rest/api) ------------------------------

const CONFLUENCE_TOOLS: IntegrationToolDef[] = [
  {
    name: 'confluence_search',
    description: 'Busca contenido en Confluence por texto o CQL. Devuelve título, id y espacio de cada página.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar (se convierte a CQL text ~ "…").' },
        cql: { type: 'string', description: 'CQL explícito (alternativa a query).' },
        limit: { type: 'number', description: 'Máximo de resultados (por defecto 10, máx 25).' },
      },
    },
    async run(args, ctx) {
      const cql = String(args.cql ?? '').trim() || (args.query ? `text ~ ${JSON.stringify(String(args.query))}` : '');
      if (!cql) return { error: 'invalid_args', detail: 'Indica query o cql.' };
      const limit = clampInt(args.limit, 10, 25);
      const res = await ctx.fetch(`${confluenceApi(ctx.cloudId)}/search?cql=${encodeURIComponent(cql)}&limit=${limit}`, {
        headers: jsonHeaders(ctx.token),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      const results = Array.isArray(asRecord(body).results) ? (asRecord(body).results as unknown[]) : [];
      return {
        results: results.map((r) => {
          const content = asRecord(asRecord(r).content);
          return {
            id: content.id ?? null,
            type: content.type ?? null,
            title: String(content.title ?? asRecord(r).title ?? '').slice(0, 120),
          };
        }),
      };
    },
  },
  {
    name: 'confluence_get_page',
    description: 'Lee una página de Confluence por su id: título, espacio y cuerpo (texto).',
    parameters: {
      type: 'object',
      properties: { pageId: { type: 'string', description: 'Id de la página.' } },
      required: ['pageId'],
    },
    async run(args, ctx) {
      const id = String(args.pageId ?? '').trim();
      if (!id) return { error: 'invalid_args', detail: 'pageId es obligatorio.' };
      const res = await ctx.fetch(`${confluenceApi(ctx.cloudId)}/content/${encodeURIComponent(id)}?expand=body.storage,space,version`, {
        headers: jsonHeaders(ctx.token),
      });
      const { ok, status, body } = await readJson(res);
      if (!ok) return fail(status, body);
      const storage = asRecord(asRecord(asRecord(body).body).storage);
      return {
        id: asRecord(body).id,
        title: String(asRecord(body).title ?? '').slice(0, 160),
        space: asRecord(asRecord(body).space).key ?? null,
        version: asRecord(asRecord(body).version).number ?? null,
        body: String(storage.value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    },
  },
  {
    name: 'confluence_create_page',
    description: 'Crea una página en Confluence en el espacio dado. El cuerpo admite HTML de almacenamiento de Confluence.',
    parameters: {
      type: 'object',
      properties: {
        spaceKey: { type: 'string', description: 'Clave del espacio, p. ej. "DOCS".' },
        title: { type: 'string', description: 'Título de la página.' },
        body: { type: 'string', description: 'Contenido (HTML/almacenamiento de Confluence o texto).' },
      },
      required: ['spaceKey', 'title', 'body'],
    },
    async run(args, ctx) {
      const spaceKey = String(args.spaceKey ?? '').trim();
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '');
      if (!spaceKey || !title) return { error: 'invalid_args', detail: 'spaceKey y title son obligatorios.' };
      const res = await ctx.fetch(`${confluenceApi(ctx.cloudId)}/content`, {
        method: 'POST',
        headers: jsonHeaders(ctx.token),
        body: JSON.stringify({
          type: 'page',
          title,
          space: { key: spaceKey },
          body: { storage: { value: body, representation: 'storage' } },
        }),
      });
      const { ok, status, body: resBody } = await readJson(res);
      if (!ok) return fail(status, resBody);
      return { created: true, id: asRecord(resBody).id, title: asRecord(resBody).title };
    },
  },
];

export const INTEGRATIONS: Record<string, IntegrationDef> = {
  atlassian: {
    key: 'atlassian',
    label: 'Atlassian',
    provider: 'jira', // una sola conexión OAuth de Atlassian sirve a Jira y Confluence
    tools: [...JIRA_TOOLS, ...CONFLUENCE_TOOLS],
  },
};

export function getIntegration(key: string): IntegrationDef | null {
  return INTEGRATIONS[key] ?? null;
}

/** Lista de integraciones (para la UI de «añadir integración» al agente). */
export function listIntegrations(): IntegrationDef[] {
  return Object.values(INTEGRATIONS);
}
