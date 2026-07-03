import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IConnectorRepository, ISecretStore } from '@core/engine';
import { getConnectorProvider } from './connector-providers';
import { interpolate } from './interpolate';

/**
 * Nodo de CONECTOR (M11): dispatch saliente AUTENTICADO. Resuelve el conector del propio tenant,
 * lee su token OAuth del `ISecretStore` (cifrado en reposo) y hace una llamada HTTP a la API del
 * proveedor (`baseUrl + path`) con `Authorization: Bearer <token>`. Nunca expone el token en el
 * contexto ni en el resultado. El token se resuelve por `workspaceId` (deny-by-default por tenant).
 */
export class ConnectorNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'connector';

  constructor(
    private readonly connectors: IConnectorRepository,
    private readonly secrets: ISecretStore,
    private readonly selfBase?: string,
    private readonly timeoutMs = 10_000,
  ) {}

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

    const token = await this.secrets.get(ctx.workspaceId, connector.credentialsSecretId);
    if (!token) return store({ error: 'connector: token no disponible (reconecta el conector).' });

    const url = provider.baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD' && rawBody != null) {
      headers['content-type'] = 'application/json';
      const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      body = interpolate(bodyStr, ctx.context, true); // jsonSafe: escapa strings incrustados
    }

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const res = await fetch(url, { method, headers, body, signal });
      // Redacta el propio token si el endpoint lo reflejara: nunca debe quedar en estado persistido.
      const bodyPreview = (await res.text()).slice(0, 1000).split(token).join('«redacted»');
      return store({ status: res.status, ok: res.ok, provider: connector.provider, bodyPreview });
    } catch (e) {
      return store({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}
