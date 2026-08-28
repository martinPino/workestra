import type { Context } from 'hono';
import { BadRequestException } from '../common';
import { workspaceOf, type AuthVariables } from '../auth.middleware';
import type { Services } from '../services';
import type { Env } from '../env';

/**
 * El contexto que comparten todos los routers: el principal autenticado, el bundle de la petición y los
 * servicios construidos para ella.
 */
export type RouterEnv = { Bindings: Env; Variables: AuthVariables & { services: Services } };

/**
 * El `workspaceId` autenticado de la petición: el equivalente del decorador `@Workspace()`. Sale del
 * principal validado, NUNCA de una cabecera o query que el cliente controle.
 */
export const ws = (c: Context<RouterEnv>): string => workspaceOf(c.get('user'));

/**
 * Parámetro de ruta obligatorio. Hono tipa `c.req.param()` como opcional cuando el parámetro viene del
 * PREFIJO de montaje (`/workflows/:workflowId/...`) y no del patrón del propio router. Que falte sería
 * un error de cableado, no de la petición, así que se falla explícito en vez de propagar un undefined.
 */
export function param(c: Context<RouterEnv>, name: string): string {
  const v = c.req.param(name);
  if (!v) throw new BadRequestException(`Falta el parámetro de ruta «${name}».`);
  return v;
}
