import { Injectable, ForbiddenException } from '../http/common';
import type { Role } from '@core/contracts';
import { can } from './rbac.policy';

/**
 * Política RBAC como servicio. Lo usa el runtime MCP para autorizar tools; las rutas HTTP la aplican
 * con el middleware `requireScopes`. Los dos evalúan la MISMA función `can()` de `@core/contracts`.
 */
@Injectable()
export class RbacService {
  can(role: Role, scope: string): boolean {
    return can(role, scope);
  }

  /** Lanza ForbiddenException si el rol no tiene el scope. Deny-by-default. */
  assert(role: Role, scope: string): void {
    if (!this.can(role, scope)) {
      throw new ForbiddenException(`Falta el scope requerido: ${scope}`);
    }
  }
}
