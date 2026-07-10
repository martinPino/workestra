import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'node:crypto';
import type { ConnectorRecord } from '@core/engine';
import { getConnectorProvider, providerEnvKeys, tokenBlobFromResponse, serializeTokenBlob, resolveConnectorToken, listDriveFolders, listSlackChannels, listSentryProjects, exchangeSentryAppCode } from '@core/sdk-plugins';
import { setCurrentWorkspace } from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';

interface OAuthState {
  cid: string;
  ws: string;
  kind: 'oauth_state';
  /** Nonce single-use (anti-replay del callback). */
  jti: string;
  /**
   * PKCE code_verifier (solo clientes públicos, p. ej. Sentry). Viaja dentro del state JWT FIRMADO y de vida
   * corta (5 min) + single-use: se mantiene el diseño stateless (sin store por-flujo, funciona con varias
   * instancias) y el intercambio de token ocurre server-side sobre HTTPS.
   */
  cv?: string;
}

const STATE_TTL_MS = 5 * 60_000;

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** PKCE (RFC 7636, S256): verifier aleatorio y su challenge = base64url(sha256(verifier)). */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

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

  /** Proveedor del que leer las credenciales OAuth: `configProvider` si lo hay (varias apps de Google
   *  comparten un único cliente `google`), o el propio proveedor. */
  private credProvider(provider: string): string {
    return getConnectorProvider(provider, this.selfBase())?.configProvider ?? provider;
  }

  /** Credenciales del cliente OAuth desde env (para `dev` se usan valores ficticios que el mock ignora). */
  private creds(provider: string): { clientId: string; clientSecret: string } {
    const { id, secret } = providerEnvKeys(this.credProvider(provider));
    return { clientId: process.env[id] ?? 'agentflow-dev', clientSecret: process.env[secret] ?? 'agentflow-dev-secret' };
  }

  /** ¿El proveedor está listo para conectar? (los que no requieren config lo están siempre). */
  isConfigured(provider: string): boolean {
    const prov = getConnectorProvider(provider, this.selfBase());
    if (!prov) return false;
    if (!prov.requiresConfig) return true;
    const { id, secret } = providerEnvKeys(this.credProvider(provider));
    // Cliente público (PKCE): basta el client_id, no hay secret.
    return !!process.env[id] && (prov.pkce === true || !!process.env[secret]);
  }

  async create(workspaceId: string, provider: string, key: string): Promise<ConnectorRecord> {
    if (!getConnectorProvider(provider, this.selfBase())) throw new BadRequestException(`Proveedor desconocido: ${provider}`);
    if (!key?.trim()) throw new BadRequestException('Falta la clave del conector.');
    return this.p.connectors.create({ workspaceId, key: key.trim(), provider });
  }

  async list(workspaceId: string): Promise<ConnectorRecord[]> {
    return this.p.connectors.listByWorkspace(workspaceId);
  }

  /**
   * Lista las carpetas del Google Drive del conector (M54): resuelve el token OAuth vigente (con refresh) y
   * consulta la Drive API. Para poblar el desplegable «Carpeta de Drive» del trigger, sin que el usuario
   * tenga que pegar un ID a mano. Aislado por tenant (deny-by-default).
   */
  async driveFolders(connectorId: string, workspaceId: string): Promise<{ folders: Array<{ id: string; name: string }> }> {
    const c = await this.p.connectors.getInWorkspace(connectorId, workspaceId);
    if (!c) throw new NotFoundException('Conector no encontrado.');
    if (c.provider !== 'google-drive') throw new BadRequestException('El conector no es de Google Drive.');
    const resolved = await resolveConnectorToken(this.p.connectors, this.p.secrets, connectorId, workspaceId);
    if (!resolved) throw new BadRequestException('El conector de Google Drive no está conectado (vuelve a conectarlo).');
    return listDriveFolders({ token: resolved.token });
  }

  /**
   * Lista los canales del Slack del conector (M57): para poblar el desplegable «Canal» del nodo conector,
   * sin escribir `#general` a mano. Mismo patrón que `driveFolders`; aislado por tenant.
   */
  async slackChannels(connectorId: string, workspaceId: string): Promise<{ channels: Array<{ id: string; name: string }> }> {
    const c = await this.p.connectors.getInWorkspace(connectorId, workspaceId);
    if (!c) throw new NotFoundException('Conector no encontrado.');
    if (c.provider !== 'slack') throw new BadRequestException('El conector no es de Slack.');
    const resolved = await resolveConnectorToken(this.p.connectors, this.p.secrets, connectorId, workspaceId);
    if (!resolved) throw new BadRequestException('El conector de Slack no está conectado (vuelve a conectarlo).');
    return listSlackChannels({ token: resolved.token });
  }

  /**
   * Lista los proyectos del Sentry del conector (M79): para poblar el desplegable «Proyecto» del trigger y de
   * las acciones. Mismo patrón que `slackChannels`; aislado por tenant. `id` es «orgSlug/projectSlug».
   */
  async sentryProjects(connectorId: string, workspaceId: string): Promise<{ projects: Array<{ id: string; name: string }> }> {
    const c = await this.p.connectors.getInWorkspace(connectorId, workspaceId);
    if (!c) throw new NotFoundException('Conector no encontrado.');
    if (c.provider !== 'sentry') throw new BadRequestException('El conector no es de Sentry.');
    const resolved = await resolveConnectorToken(this.p.connectors, this.p.secrets, connectorId, workspaceId);
    if (!resolved) throw new BadRequestException('El conector de Sentry no está conectado (vuelve a conectarlo).');
    return listSentryProjects({ token: resolved.token });
  }

  /**
   * Callback de instalación de la Sentry App (M80): Sentry redirige aquí tras instalar con `code` + `installationId`.
   * Autoriza la instalación (intercambia el code) — best-effort: aunque falle (code caducado), la instalación ya
   * existe y los webhooks se enrutan por contenido. Siempre redirige a la app para no dejar al usuario en un 404.
   */
  async sentryAppCallback(installationId: string, code: string): Promise<{ redirectTo: string }> {
    const web = this.webBase();
    const clientId = process.env.SENTRY_APP_CLIENT_ID ?? '';
    const clientSecret = process.env.SENTRY_APP_CLIENT_SECRET ?? '';
    let ok = false;
    if (installationId && code && clientId && clientSecret) {
      const r = await exchangeSentryAppCode({ installationId, code, clientId, clientSecret }).catch(() => ({ ok: false }));
      ok = r.ok;
    }
    return { redirectTo: `${web}/integrations?sentry=${ok ? 'installed' : 'installed_check'}` };
  }

  /** Inicia el flujo OAuth: devuelve la URL de autorización con un `state` firmado (10 min). */
  async connect(id: string, workspaceId: string): Promise<{ authorizeUrl: string }> {
    const c = await this.p.connectors.getInWorkspace(id, workspaceId);
    assertInWorkspace(c?.workspaceId, workspaceId, 'Connector');
    const provider = getConnectorProvider((c as ConnectorRecord).provider, this.selfBase());
    if (!provider) throw new BadRequestException('Proveedor desconocido.');
    if (!this.isConfigured(provider.provider)) {
      const { id, secret } = providerEnvKeys(this.credProvider(provider.provider));
      const need = provider.pkce ? id : `${id} y ${secret}`;
      throw new BadRequestException(`El proveedor «${provider.label}» requiere ${need} configurado en el servidor.`);
    }
    // PKCE (clientes públicos, p. ej. Sentry): el verifier se guarda dentro del state firmado; el challenge va en la URL.
    const pkce = provider.pkce ? pkcePair() : null;
    const state = this.jwt.sign(
      { cid: id, ws: workspaceId, kind: 'oauth_state', jti: randomBytes(12).toString('hex'), ...(pkce ? { cv: pkce.verifier } : {}) } satisfies OAuthState,
      { expiresIn: '5m' },
    );
    const { clientId } = this.creds(provider.provider);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: `${this.selfBase()}/connectors/callback`,
      scope: provider.scopes.join(' '),
      state,
      ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: 'S256' } : {}),
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
    // Slack/GitHub usan form-urlencoded; Atlassian/dev usan JSON. Confidencial → client_secret;
    // público (PKCE, p. ej. Sentry) → code_verifier del state y SIN client_secret.
    const { clientId, clientSecret } = this.creds(provider.provider);
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${this.selfBase()}/connectors/callback`,
      client_id: clientId,
      ...(provider.pkce ? { code_verifier: payload.cv ?? '' } : { client_secret: clientSecret }),
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
    // Guardamos el blob completo (access + refresh + expiry) para poder renovar sin re-autenticar (M28).
    // Si el proveedor no da refresh/expiry (Slack/GitHub), serializeTokenBlob guarda el access suelto (compat).
    await this.p.secrets.set(ws, secretKey, serializeTokenBlob(tokenBlobFromResponse(tokJson, accessToken, Date.now())));
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
