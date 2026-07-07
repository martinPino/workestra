import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IConnectorRepository, ISecretStore } from '@core/engine';
import { getConnectorProvider } from './connector-providers';
import { parseTokenBlob, serializeTokenBlob, needsRefresh, refreshAccessToken } from './oauth-token';
import { jiraAccessibleResources } from './jira-webhooks';
import { interpolate } from './interpolate';

/**
 * Construye el mensaje RFC822 que exige la API de Gmail (`{ raw: base64url(mime) }`). Se llama DESPUÉS de
 * interpolar, así que destinatario/asunto/cuerpo ya llevan resueltos los `{{datos}}` de pasos previos.
 * El asunto va como encoded-word UTF-8 y el cuerpo en base64 (correcto con acentos/emoji). Los headers se
 * sanean de saltos de línea para evitar inyección de cabeceras. Puro y testeable.
 */
/**
 * Parsea la respuesta a JSON para EXPONERLA a nodos posteriores (`{{connector:nodo.json.…}}`), pero solo si
 * es segura: JSON pequeño (≤32 KB, no infla el contexto persistido) y que NO contiene el token (no podemos
 * redactarlo dentro de un objeto). `undefined` si no cumple o no es JSON. Puro y testeable.
 */
export function safeResponseJson(text: string, token: string): unknown {
  if (text.length > 32_000 || (token && text.includes(token))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function gmailRawMessage(msg: { to?: string; subject?: string; text?: string }): string {
  const headerSafe = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
  const to = headerSafe(String(msg.to ?? ''));
  const subjectRaw = String(msg.subject ?? '');
  // Encoded-word solo si hay asunto: `=?UTF-8?B??=` (encoded-text vacío) es inválido según RFC 2047.
  const subject = subjectRaw ? `=?UTF-8?B?${Buffer.from(subjectRaw).toString('base64')}?=` : '';
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(msg.text ?? '')).toString('base64'),
  ].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}

/**
 * Nodo de CONECTOR (M11): dispatch saliente AUTENTICADO. Resuelve el conector del propio tenant,
 * lee su token OAuth del `ISecretStore` (cifrado en reposo) y hace una llamada HTTP a la API del
 * proveedor (`baseUrl + path`) con `Authorization: Bearer <token>`. Nunca expone el token en el
 * contexto ni en el resultado. El token se resuelve por `workspaceId` (deny-by-default por tenant).
 */
export class ConnectorNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'connector';
  /** Cache best-effort del cloudId de Jira por token (evita re-resolver en cada llamada). */
  private readonly cloudIdCache = new Map<string, string>();

  constructor(
    private readonly connectors: IConnectorRepository,
    private readonly secrets: ISecretStore,
    private readonly selfBase?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  /** Resuelve el cloudId del sitio de Jira con el token OAuth (para sustituir `{cloudid}` en la ruta). */
  private async jiraCloudId(token: string): Promise<string | null> {
    const cached = this.cloudIdCache.get(token);
    if (cached) return cached;
    try {
      const sites = await jiraAccessibleResources(token, (u, i) => fetch(u, i));
      const id = sites[0]?.id;
      if (id) {
        this.cloudIdCache.set(token, id);
        return id;
      }
    } catch {
      /* red/permiso: se devuelve null y el nodo reporta un error claro */
    }
    return null;
  }

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const connectorId = String(ctx.config.connectorId ?? '');
    const method = String(ctx.config.method ?? 'GET').toUpperCase();
    // Interpolación (M12): ruta y cuerpo pueden usar la salida de nodos previos, p. ej.
    // `{"text":"{{agent:LLM.output}}"}`. `jsonSafe` en el cuerpo escapa strings para no romper el JSON.
    const path = interpolate(String(ctx.config.path ?? '/'), ctx.context);
    const rawBody = ctx.config.body;

    const store = (result: Record<string, unknown>): NodeResult => ({
      context: { ...ctx.context, variables: { ...ctx.context.variables, [`connector:${ctx.nodeKey}`]: result } },
      control: { kind: 'continue' },
    });

    if (!connectorId) return store({ error: 'connector: falta connectorId en la config del nodo.' });
    // Endurecimiento (M12): la ruta interpolada no debe poder escapar del endpoint del proveedor.
    // Rechaza travesía de directorios (`..`), espacios/whitespace y caracteres de control, evitando
    // que la salida (potencialmente influida por datos externos) redirija la llamada a `../admin/...`.
    if (/\.\.|\s/u.test(path)) {
      return store({ error: 'connector: la ruta interpolada contiene «..», espacios o caracteres no permitidos.' });
    }

    // Deny-by-default por tenant: nunca resuelve un conector de otro workspace.
    const connector = await this.connectors.getInWorkspace(connectorId, ctx.workspaceId);
    if (!connector) return store({ error: `connector: no encontrado (${connectorId}).` });
    if (connector.status !== 'connected' || !connector.credentialsSecretId) {
      return store({ error: `connector: «${connector.key}» no está conectado.` });
    }

    const provider = getConnectorProvider(connector.provider, this.selfBase);
    if (!provider) return store({ error: `connector: proveedor desconocido (${connector.provider}).` });

    const rawSecret = await this.secrets.get(ctx.workspaceId, connector.credentialsSecretId);
    if (!rawSecret) return store({ error: 'connector: token no disponible (reconecta el conector).' });
    // Renueva el access token si caducó y hay refresh (Google/Atlassian…), y persiste el nuevo: así el
    // conector no muere al expirar el token (~1 h). Best-effort: si el refresh falla, se prueba con el actual.
    let blob = parseTokenBlob(rawSecret);
    if (needsRefresh(blob, Date.now())) {
      const refreshed = await refreshAccessToken(connector.provider, blob, Date.now(), (u, i) => fetch(u, i as RequestInit));
      if (refreshed) {
        blob = refreshed;
        await this.secrets.set(ctx.workspaceId, connector.credentialsSecretId, serializeTokenBlob(refreshed));
      }
    }
    const token = blob.access_token;

    // Las acciones de Jira usan el marcador `{cloudid}` en la ruta; lo resolvemos aquí en runtime (no en el
    // editor), evitando carreras/estado obsoleto en el cliente. El cloudId (uuid de Atlassian) es seguro.
    let resolvedPath = path;
    if (connector.provider === 'jira' && resolvedPath.includes('{cloudid}')) {
      const cloudId = await this.jiraCloudId(token);
      if (!cloudId) return store({ error: 'connector: no se pudo resolver el sitio de Jira (reconecta el conector).' });
      resolvedPath = resolvedPath.split('{cloudid}').join(cloudId);
    }

    // Salesforce (M47): la API vive en la URL del org que devolvió el OAuth (`instance_url`), no en una base
    // fija. Si el conector la guardó en el blob, se usa como base; si no, cae a la base del proveedor.
    const base = connector.provider === 'salesforce' && blob.instance_url ? blob.instance_url : provider.baseUrl;
    const url = base.replace(/\/$/, '') + (resolvedPath.startsWith('/') ? resolvedPath : `/${resolvedPath}`);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD' && rawBody != null) {
      headers['content-type'] = 'application/json';
      const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      body = interpolate(bodyStr, ctx.context, true); // jsonSafe: escapa strings incrustados
    }

    // Gmail: la API exige el mensaje RFC822 en base64url dentro de `{ raw }`. La acción guarda un body
    // `{to,subject,text}`; aquí (ya interpolado, así los {{datos}} funcionan) lo transformamos al formato Gmail.
    if (connector.provider === 'gmail' && resolvedPath === '/users/me/messages/send') {
      if (!body) return store({ error: 'connector: falta el contenido del correo de Gmail.' });
      try {
        const m = JSON.parse(body) as { to?: string; subject?: string; text?: string };
        body = JSON.stringify({ raw: gmailRawMessage(m) });
      } catch {
        return store({ error: 'connector: no se pudo construir el correo de Gmail.' });
      }
    }

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const res = await fetch(url, { method, headers, body, signal });
      const text = await res.text();
      // Redacta el propio token si el endpoint lo reflejara: nunca debe quedar en estado persistido.
      const bodyPreview = text.slice(0, 4000).split(token).join('«redacted»');
      const json = safeResponseJson(text, token); // respuesta parseada para {{connector:nodo.json.…}} (M28b)
      return store({ status: res.status, ok: res.ok, provider: connector.provider, bodyPreview, json });
    } catch (e) {
      return store({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}
