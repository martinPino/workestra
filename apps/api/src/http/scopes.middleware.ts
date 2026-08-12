import type { MiddlewareHandler } from 'hono';
import { can } from '@core/contracts';
import { ForbiddenException } from './errors';
import type { AuthVariables } from './auth.middleware';

/**
 * Exige scopes RBAC a una ruta: port de `ScopesGuard` + `@RequireScopes()`.
 *
 * Lo que cambia respecto a Nest no es la política —sigue siendo `can()` de `@core/contracts`, la misma
 * que usa el runtime de agentes para autorizar tools— sino DÓNDE se declara: antes era un decorador
 * junto al handler, ahora es un middleware en la definición de la ruta. El riesgo del port está en
 * perder un `requireScopes` por el camino, no en la evaluación.
 *
 *     router.post('/', requireScopes('agent:write'), (c) => …)
 */
export function requireScopes(...scopes: string[]): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (scopes.length === 0) return next();

    const role = c.get('user')?.role;
    // Sin rol no se evalúa la política: se deniega. Llegar aquí sin principal significa que la ruta se
    // montó sin el middleware de auth delante, y en ese caso fallar es lo correcto.
    if (!role) throw new ForbiddenException('No autenticado o sin rol asignado.');

    for (const scope of scopes) {
      if (!can(role, scope)) throw new ForbiddenException(`Falta el scope requerido: ${scope}`);
    }
    return next();
  };
}
