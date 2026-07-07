import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setCurrentWorkspace } from '@core/infra';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { isApiKey, resolveApiKey } from '../api-keys/api-key.util';

/**
 * Verifica el Bearer y adjunta el principal (incl. `workspaceId`) a `req.user`. Acepta DOS credenciales:
 * un JWT de sesión (1 h) o una API key `af_…` (M32, duradera, para MCP/apps externas). Registrado como
 * guard GLOBAL: exige autenticación en TODA ruta salvo las `@Public()`. Así el `workspaceId` autenticado
 * está disponible en todos los handlers para acotar por tenant.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      req.user = principal;
      setCurrentWorkspace(principal.workspaceId);
      return true;
    }

    try {
      const payload = this.auth.verify(token);
      // Rechaza tokens que NO son de sesión (p. ej. el `oauth_state` de conectores, firmado con el
      // mismo secreto). Un token de sesión no lleva `kind`; uno con `kind` no es un principal válido.
      if ((payload as { kind?: string }).kind) throw new UnauthorizedException('Tipo de token no válido para sesión.');
      req.user = payload;
      // Alimenta el contexto de tenant (M10) para la barrera RLS: SET LOCAL app.current_workspace
      // en las consultas Prisma de esta petición. No-op si el middleware ALS no está montado (RLS off).
      if (payload.workspaceId) setCurrentWorkspace(payload.workspaceId);
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }
  }
}
