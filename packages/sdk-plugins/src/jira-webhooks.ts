/**
 * Helpers REST para los WEBHOOKS DINÁMICOS de Jira Cloud (triggers sin código, M19). Con estos, cuando el
 * usuario elige «Cuando se crea un ticket de Jira», AgentFlow registra el webhook EN Jira por él usando el
 * token OAuth del conector — sin que el usuario copie URLs ni monte una Automation rule.
 *
 * Detalles de la API (verificados en developer.atlassian.com):
 *  - Scope OAuth requerido: `manage:jira-webhook` (+ `offline_access` para renovar).
 *  - Registrar: POST /ex/jira/{cloudId}/rest/api/3/webhook  → devuelve `createdWebhookId` (el remoteId).
 *  - Borrar: DELETE …/webhook  con { webhookIds }.
 *  - Renovar (caducan a los 30 días): PUT …/webhook/refresh  con { webhookIds }.
 *  - Los webhooks dinámicos NO admiten cabeceras personalizadas → el secreto va en la URL (`?token=…`).
 *  - `jqlFilter` es OBLIGATORIO (Jira no acepta un webhook sin filtro), p. ej. «project = KAN».
 */

const ATLASSIAN_API = 'https://api.atlassian.com';

/** `fetch` mínimo e inyectable: permite pasar un stub en los tests sin depender del tipo DOM completo. */
export type JiraFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface JiraSite {
  id: string; // el cloudId
  url: string;
  name: string;
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

const jiraApi = (cloudId: string) => `${ATLASSIAN_API}/ex/jira/${cloudId}/rest/api/3`;

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json',
});

/**
 * Sitios de Jira accesibles con este token OAuth (para resolver el cloudId). Si el usuario tiene más de un
 * sitio, hay que preguntarle cuál; con uno solo, se usa directamente.
 */
export async function jiraAccessibleResources(token: string, fetchFn: JiraFetch): Promise<JiraSite[]> {
  const res = await fetchFn(`${ATLASSIAN_API}/oauth/token/accessible-resources`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira accessible-resources: HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  return json.map((s) => {
    const r = asRecord(s);
    return { id: String(r.id ?? ''), url: String(r.url ?? ''), name: String(r.name ?? '') };
  });
}

export interface JiraProject {
  key: string;
  name: string;
}

/** Proyectos del sitio Jira (para poblar el desplegable del picker; el jqlFilter usa `project = <key>`). */
export async function listJiraProjects(token: string, cloudId: string, fetchFn: JiraFetch): Promise<JiraProject[]> {
  const res = await fetchFn(`${jiraApi(cloudId)}/project/search`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Jira project search: HTTP ${res.status}`);
  const json = asRecord(await res.json());
  const values = Array.isArray(json.values) ? json.values : [];
  return values.map((v) => {
    const r = asRecord(v);
    return { key: String(r.key ?? ''), name: String(r.name ?? '') };
  });
}

export interface RegisterWebhookInput {
  /** Nuestra URL de ingreso, YA con `?token=<secret>` (el secreto va en la URL, no en cabecera). */
  url: string;
  /** Eventos REST de Jira, p. ej. ['jira:issue_created']. */
  events: string[];
  /** Filtro JQL obligatorio, p. ej. 'project = KAN'. */
  jqlFilter: string;
}

/** Registra un webhook dinámico en Jira. Devuelve el/los id(s) creados (remoteId) para poder borrarlo luego. */
export async function registerJiraWebhook(
  token: string,
  cloudId: string,
  input: RegisterWebhookInput,
  fetchFn: JiraFetch,
): Promise<number[]> {
  const res = await fetchFn(`${jiraApi(cloudId)}/webhook`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ url: input.url, webhooks: [{ events: input.events, jqlFilter: input.jqlFilter }] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Jira webhook register: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  const results = asRecord(json).webhookRegistrationResult;
  const ids: number[] = [];
  const errors: string[] = [];
  if (Array.isArray(results)) {
    for (const r of results) {
      const rec = asRecord(r);
      if (typeof rec.createdWebhookId === 'number') ids.push(rec.createdWebhookId);
      else if (typeof rec.createdWebhookId === 'string' && /^\d+$/.test(rec.createdWebhookId)) ids.push(Number(rec.createdWebhookId));
      else if (Array.isArray(rec.errors)) errors.push(...rec.errors.map(String));
    }
  }
  if (!ids.length) throw new Error(`Jira webhook register sin id: ${errors.join('; ') || JSON.stringify(json).slice(0, 200)}`);
  return ids;
}

/** Borra webhooks dinámicos por id (al pausar/eliminar el trigger o desconectar el conector). */
export async function deleteJiraWebhooks(token: string, cloudId: string, webhookIds: number[], fetchFn: JiraFetch): Promise<void> {
  if (!webhookIds.length) return;
  const res = await fetchFn(`${jiraApi(cloudId)}/webhook`, {
    method: 'DELETE',
    headers: authHeaders(token),
    body: JSON.stringify({ webhookIds }),
  });
  // Jira responde 202/204 al aceptar el borrado.
  if (!res.ok && res.status !== 202 && res.status !== 204) throw new Error(`Jira webhook delete: HTTP ${res.status}`);
}

/**
 * Lista los ids de TODOS los webhooks dinámicos del usuario (paginado). Jira solo permite UNA URL por
 * usuario, así que antes de registrar hay que borrar los que sobren (huérfanos de intentos previos).
 */
export async function listJiraWebhookIds(token: string, cloudId: string, fetchFn: JiraFetch): Promise<number[]> {
  const ids: number[] = [];
  let startAt = 0;
  for (let page = 0; page < 50; page++) {
    const res = await fetchFn(`${jiraApi(cloudId)}/webhook?startAt=${startAt}&maxResults=100`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Jira webhook list: HTTP ${res.status}`);
    const json = asRecord(await res.json());
    const values = Array.isArray(json.values) ? json.values : [];
    for (const v of values) {
      const id = asRecord(v).id;
      if (typeof id === 'number') ids.push(id);
      else if (typeof id === 'string' && /^\d+$/.test(id)) ids.push(Number(id));
    }
    if (json.isLast === true || values.length === 0) break;
    startAt += values.length;
  }
  return ids;
}

export interface WebhookEntry {
  events: string[];
  jqlFilter: string;
}

/**
 * Registra VARIOS webhooks bajo UNA misma URL (el límite de Jira es una URL por usuario, pero admite
 * múltiples configs con distinto evento/JQL). Devuelve el createdWebhookId de cada entrada EN ORDEN
 * (null si esa entrada falló) — Atlassian garantiza que el resultado va en el mismo orden que la petición.
 */
export async function registerJiraWebhooks(
  token: string,
  cloudId: string,
  url: string,
  entries: WebhookEntry[],
  fetchFn: JiraFetch,
): Promise<Array<number | null>> {
  if (!entries.length) return [];
  const res = await fetchFn(`${jiraApi(cloudId)}/webhook`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ url, webhooks: entries.map((e) => ({ events: e.events, jqlFilter: e.jqlFilter })) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Jira webhook register: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  const results = asRecord(json).webhookRegistrationResult;
  const arr = Array.isArray(results) ? results : [];
  return entries.map((_, i) => {
    const rec = asRecord(arr[i]);
    if (typeof rec.createdWebhookId === 'number') return rec.createdWebhookId;
    if (typeof rec.createdWebhookId === 'string' && /^\d+$/.test(rec.createdWebhookId)) return Number(rec.createdWebhookId);
    return null;
  });
}

/** Renueva la vida de los webhooks (caducan a los 30 días; cada refresh suma otros 30). */
export async function refreshJiraWebhooks(token: string, cloudId: string, webhookIds: number[], fetchFn: JiraFetch): Promise<void> {
  if (!webhookIds.length) return;
  const res = await fetchFn(`${jiraApi(cloudId)}/webhook/refresh`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({ webhookIds }),
  });
  if (!res.ok) throw new Error(`Jira webhook refresh: HTTP ${res.status}`);
}
