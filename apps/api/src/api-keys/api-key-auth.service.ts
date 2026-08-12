import { Inject, Injectable } from '../http/common';
import type { IApiKeyRepository, ApiKeyRecord } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';
import { generateRawKey, hashKey, type ApiKeyPrincipal } from './api-key.util';

/** Vista pública de una clave (sin hash ni clave en claro): para listarlas en la UI. */
export interface ApiKeyView {
  id: string;
  prefix: string;
  last4: string;
  label: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

@Injectable()
export class ApiKeyAuthService {
  private readonly repo: IApiKeyRepository;
  constructor(@Inject(PERSISTENCE) p: PersistenceBundle) {
    this.repo = p.apiKeys;
  }

  /**
   * Crea una clave para el principal actual (hereda su workspace y rol). Devuelve la clave EN CLARO
   * una sola vez — no vuelve a estar disponible. El label ayuda a identificarla luego.
   */
  async create(principal: ApiKeyPrincipal, label: string): Promise<{ id: string; rawKey: string; view: ApiKeyView }> {
    const { raw, prefix, last4 } = generateRawKey();
    const rec = await this.repo.create({
      workspaceId: principal.workspaceId,
      userSub: principal.sub,
      email: principal.email,
      role: principal.role,
      hashedKey: hashKey(raw),
      prefix,
      last4,
      label: (label || 'MCP').trim().slice(0, 80),
    });
    return { id: rec.id, rawKey: raw, view: this.toView(rec) };
  }

  async list(workspaceId: string): Promise<ApiKeyView[]> {
    const rows = await this.repo.listByWorkspace(workspaceId);
    return rows.map((r) => this.toView(r));
  }

  async revoke(id: string, workspaceId: string): Promise<{ revoked: boolean }> {
    const r = await this.repo.revoke(id, workspaceId);
    return { revoked: r !== null };
  }

  private toView(r: ApiKeyRecord): ApiKeyView {
    return {
      id: r.id,
      prefix: r.prefix,
      last4: r.last4,
      label: r.label,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    };
  }
}
