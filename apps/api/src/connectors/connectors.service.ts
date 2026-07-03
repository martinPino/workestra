import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import type { ConnectorRecord } from '@core/engine';
import { getConnectorProvider, providerEnvKeys } from '@core/sdk-plugins';
import { setCurrentWorkspace } from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';

interface OAuthState {
  cid: string;
  ws: string;
  kind: 'oauth_state';
  /** Nonce single-use (anti-replay del callback). */
  jti: string;
}

const STATE_TTL_MS = 5 * 60_000;

const secretKeyFor = (connectorId: string) => `connector:${connectorId}:oauth`;

/** Lee `path` (dot-notation) de un objeto de respuesta de token. */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/**
 * Conectores (M11): integraciones OAuth para dispatch saliente autenticado. El TOKEN se guarda
 * CIFRADO en el `ISecretStore` y solo se referencia por clave; el nodo de conector lo usa en runtime.
 * El proveedor `dev` (servido por esta misma API) permite probar el flujo completo sin apps reales.
 */
@Injectable()
export class ConnectorsService {
  /** Nonces de state ya consumidos (anti-replay). Best-effort en memoria; el TTL del JWT es el tope. */
  private readonly usedStates = new Map<string, number>();

  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly jwt: JwtService,
  ) {}

  /** Marca un nonce como usado; devuelve false si ya lo estaba (replay). Purga los caducados. */
  private consumeState(jti: string): boolean {
    const now = Date.now();
    for (const [k, exp] of this.usedStates) if (exp < now) this.usedStates.delete(k);
    if (this.usedStates.has(jti)) return false;
    this.usedStates.set(jti, now + STATE_TTL_MS);
    return true;
  }

  private selfBase(): string {
    return process.env.API_SELF_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;
  }
  private webBase(): string {
    return process.env.WEB_URL ?? 'http://localhost:5173';
  }

  /** Credenciales del cliente OAuth desde env (para `dev` se usan valores ficticios que el mock ignora). */
  private creds(provider: string): { clientId: string; clientSecret: string } {
    const { id, secret } = providerEnvKeys(provider);
    return { clientId: process.env[id] ?? 'agentflow-dev', clientSecret: process.env[secret] ?? 'agentflow-dev-secret' };
  }

  /** ¿El proveedor está listo para conectar? (los que no requieren config lo están siempre). */
  isConfigured(provider: string): boolean {
    const prov = getConnectorProvider(provider, this.selfBase());
    if (!prov) return false;
    if (!prov.requiresConfig) return true;
    const { id, secret } = providerEnvKeys(provider);
    return !!process.env[id] && !!process.env[secret];
  }

  async create(workspaceId: string, provider: string, key: string): Promise<ConnectorRecord> {
    if (!getConnectorProvider(provider, this.selfBase())) throw new BadRequestException(`Proveedor desconocido: ${provider}`);
    if (!key?.trim()) throw new BadRequestException('Falta la clave del conector.');
    return this.p.connectors.create({ workspaceId, key: key.trim(), provider });
  }

  async list(workspaceId: string): Promise<ConnectorRecord[]> {
    return this.p.connectors.listByWorkspace(workspaceId);
  }

  /** Inicia el flujo OAuth: devuelve la URL de autorización con un `state` firmado (10 min). */
  async connect(id: string, workspaceId: string): Promise<{ authorizeUrl: string }> {
    const c = await this.p.connectors.getInWorkspace(id, workspaceId);
    assertInWorkspace(c?.workspaceId, workspaceId, 'Connector');
    const provider = getConnectorProvider((c as ConnectorRecord).provider, this.selfBase());
    if (!provider) throw new BadRequestException('Proveedor desconocido.');
    if (!this.isConfigured(provider.provider)) {
      const { id, secret } = providerEnvKeys(provider.provider);
      throw new BadRequestException(`El proveedor «${provider.label}» requiere ${id} y ${secret} configurados en el servidor.`);
    }
    const state = this.jwt.sign(
      { cid: id, ws: workspaceId, kind: 'oauth_state', jti: randomBytes(12).toString('hex') } satisfies OAuthState,
      { expiresIn: '5m' },
    );
    const { clientId } = this.creds(provider.provider);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: `${this.selfBase()}/connectors/callback`,
      scope: provider.scopes.join(' '),
      state,
      ...(provider.extraAuthorizeParams ?? {}),
    });
    return { authorizeUrl: `${provider.authorizeUrl}?${params.toString()}` };
  }

  /**
   * Callback OAuth (ruta pública): valida el `state` firmado, intercambia el `code` por el token en
   * el proveedor y lo guarda CIFRADO, marcando el conector como conectado. Devuelve a dónde redirigir.
   */
  async callback(code: string, state: string): Promise<{ redirectTo: string }> {
    if (!code || !state) throw new BadRequestException('Faltan code/state.');
    let payload: OAuthState;
    try {
      payload = this.jwt.verify<OAuthState>(state);
    } catch {
      throw new BadRequestException('state inválido o expirado.');
    }
    if (payload.kind !== 'oauth_state') throw new BadRequestException('state inválido.');
    if (!payload.jti || !this.consumeState(payload.jti)) throw new BadRequestException('state ya usado o inválido (replay).');
    const { cid, ws } = payload;
    // Endurecimiento RLS (M10): a partir de aquí operamos tenant-scoped bajo la 2ª barrera.
    setCurrentWorkspace(ws);
    const c = await this.p.connectors.getInWorkspace(cid, ws);
    if (!c) throw new NotFoundException('Conector no encontrado.');
    const provider = getConnectorProvider(c.provider, this.selfBase());
    if (!provider) throw new BadRequestException('Proveedor desconocido.');

    // Intercambio code→token contra el endpoint del proveedor. Formato y credenciales según catálogo:
    // Slack/GitHub usan form-urlencoded; Atlassian/dev usan JSON. Se incluye client_id/secret.
    const { clientId, clientSecret } = this.creds(provider.provider);
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${this.selfBase()}/connectors/callback`,
      client_id: clientId,
      client_secret: clientSecret,
    };
    const res =
      provider.tokenExchange === 'form'
        ? await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams(fields).toString(),
          })
        : await fetch(provider.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(fields),
          });
    const tokJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = getByPath(tokJson, provider.tokenPath);
    // Slack devuelve HTTP 200 con { ok:false } en error; exigimos un access token no vacío.
    if (!res.ok || tokJson.ok === false || typeof accessToken !== 'string' || !accessToken) {
      throw new BadRequestException('El intercambio de token con el proveedor falló.');
    }

    const secretKey = secretKeyFor(cid);
    await this.p.secrets.set(ws, secretKey, accessToken);
    await this.p.connectors.setConnected(cid, secretKey);
    return { redirectTo: `${this.webBase()}/integrations?connected=${encodeURIComponent(c.key)}` };
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    const c = await this.p.connectors.getInWorkspace(id, workspaceId);
    if (!c) return;
    await this.p.connectors.delete(id);
    if (c.credentialsSecretId) await this.p.secrets.delete(workspaceId, c.credentialsSecretId);
  }
}
