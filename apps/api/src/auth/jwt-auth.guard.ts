import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@core/contracts';
import { setCurrentWorkspace } from '@core/infra/postgres';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';
import { isApiKey, resolveApiKey } from '../api-keys/api-key.util';

// Estado autoritativo de la cuenta, cacheado brevemente para no consultar la BD en CADA petición (M74).
interface AccountStatus {
  disabled: boolean;
  role: Role;
  workspaceId: string;
}
const STATUS_TTL_MS = 10_000; // ventana máxima de revocación tras «cerrar cuenta»: 10s

/**
 * Verifica el Bearer y adjunta el principal (incl. `workspaceId`) a `req.user`. Acepta DOS credenciales:
 * un JWT de sesión (1 h) o una API key `af_…` (M32, duradera, para MCP/apps externas). Registrado como
 * guard GLOBAL: exige autenticación en TODA ruta salvo las `@Public()`. Así el `workspaceId` autenticado
 * está disponible en todos los handlers para acotar por tenant.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  // Cache email→estado (TTL corto): revalidar «cuenta cerrada» en CADA petición sin martillear la BD.
  private readonly statusCache = new Map<string, { status: AccountStatus | null; exp: number }>();

  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    @Inject(PERSISTENCE) private readonly persistence: PersistenceBundle,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el Bearer token.');
    }
    const token = header.slice('Bearer '.length);

    // API key (`af_…`): resuelve al MISMO principal que un JWT (sub/email/role/workspaceId), de modo que
    // todo el scoping/RBAC por tenant funciona igual. La clave vive hasheada; el lookup es por su hash.
    if (isApiKey(token)) {
      const principal = await resolveApiKey(this.persistence.apiKeys, token);
      if (!principal) throw new UnauthorizedException('API key inválida o revocada.');
      // Una clave cuyo dueño fue «cerrado» deja de funcionar (offboarding). Fail-open si la BD falla.
      const status = await this.statusOf(principal.email);
      if (status && status.disabled) throw new UnauthorizedException('Cuenta desactivada.');
      req.user = status ? { ...principal, role: status.role, workspaceId: status.workspaceId } : principal;
      setCurrentWorkspace((req.user as { workspaceId: string }).workspaceId);
      return true;
    }

    let payload;
    try {
      payload = this.auth.verify(token);
      // Rechaza tokens que NO son de sesión (p. ej. el `oauth_state` de conectores, firmado con el
      // mismo secreto). Un token de sesión no lleva `kind`; uno con `kind` no es un principal válido.
      if ((payload as { kind?: string }).kind) throw new UnauthorizedException('Tipo de token no válido para sesión.');
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }

    // Revalidación por petición (M74): «cerrar cuenta» debe revocar el acceso YA, no solo en el próximo
    // login. Releemos el estado autoritativo (desactivado + rol/workspace ACTUALES) y, si está cerrada,
    // rechazamos aunque el JWT siga vigente. También corrige privilegios obsoletos (rol degradado).
    const status = await this.statusOf(payload.email);
    if (status && status.disabled) throw new UnauthorizedException('Cuenta desactivada.');
    // Si hay estado autoritativo, manda sobre el token (rol/workspace de la BD). Si la BD falló
    // (status === null por error), caemos al token para no provocar una caída total de auth.
    req.user = status ? { sub: payload.sub, email: payload.email, role: status.role, workspaceId: status.workspaceId } : payload;
    const ws = (req.user as { workspaceId?: string }).workspaceId;
    if (ws) setCurrentWorkspace(ws);
    return true;
  }

  /**
   * Estado autoritativo de una cuenta por email, con cache de 10s. Devuelve `null` si no se pudo determinar
   * (usuario inexistente o error de BD) → el llamador hace fail-open (usa el token) para no tumbar la auth
   * ante un fallo transitorio de BD; la única acción «dura» es rechazar cuando la cuenta está cerrada.
   */
  private async statusOf(email: string): Promise<AccountStatus | null> {
    const now = Date.now();
    const cached = this.statusCache.get(email);
    if (cached && cached.exp > now) return cached.status;
    let status: AccountStatus | null = null;
    try {
      const acct = await this.persistence.auth.findByEmail(email);
      if (acct) status = { disabled: !!acct.disabledAt, role: acct.role, workspaceId: acct.workspaceId };
    } catch {
      status = null; // error de BD → fail-open (no cacheamos un fallo transitorio mucho tiempo)
    }
    this.statusCache.set(email, { status, exp: now + STATUS_TTL_MS });
    if (this.statusCache.size > 5000) {
      for (const [k, v] of this.statusCache) if (v.exp <= now) this.statusCache.delete(k);
    }
    return status;
  }
}
