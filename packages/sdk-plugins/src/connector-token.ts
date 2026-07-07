import type { IConnectorRepository, ISecretStore } from '@core/engine';
import { parseTokenBlob, serializeTokenBlob, needsRefresh, refreshAccessToken, type TokenBlob } from './oauth-token';

export interface ResolvedConnectorToken {
  token: string;
  blob: TokenBlob;
  provider: string;
}

/**
 * Resuelve el ACCESS TOKEN vigente de un conector del propio tenant (mismo camino que `ConnectorNodeExecutor`:
 * lee el blob cifrado del secret store y renueva con el refresh token si caducó, persistiendo el nuevo). Se
 * extrae aparte porque lo usan disparadores fuera del grafo (p. ej. el sondeo de Google Drive del worker), que
 * necesitan el token del conector sin ejecutar un nodo. `null` si el conector no existe/está desconectado.
 */
export async function resolveConnectorToken(
  connectors: IConnectorRepository,
  secrets: ISecretStore,
  connectorId: string,
  workspaceId: string,
  now: number = Date.now(),
): Promise<ResolvedConnectorToken | null> {
  const connector = await connectors.getInWorkspace(connectorId, workspaceId);
  if (!connector) return null;
  if (connector.status !== 'connected' || !connector.credentialsSecretId) return null;
  const rawSecret = await secrets.get(workspaceId, connector.credentialsSecretId);
  if (!rawSecret) return null;
  let blob = parseTokenBlob(rawSecret);
  if (needsRefresh(blob, now)) {
    const refreshed = await refreshAccessToken(connector.provider, blob, now, (u, i) => fetch(u, i as RequestInit));
    if (refreshed) {
      blob = refreshed;
      await secrets.set(workspaceId, connector.credentialsSecretId, serializeTokenBlob(refreshed));
    }
  }
  return { token: blob.access_token, blob, provider: connector.provider };
}
