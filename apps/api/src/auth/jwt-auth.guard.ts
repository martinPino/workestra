import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { setCurrentWorkspace } from '@core/infra';
import { AuthService } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Verifica el Bearer JWT y adjunta el payload (incl. `workspaceId`) a `req.user`. Registrado como
 * guard GLOBAL: exige autenticación en TODA ruta salvo las marcadas `@Public()` (health, emisión de
 * token, ingreso de webhooks firmados). Así el `workspaceId` autenticado está disponible en todos
 * los handlers de negocio para acotar por tenant.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el Bearer token.');
    }
    try {
      const payload = this.auth.verify(header.slice('Bearer '.length));
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
