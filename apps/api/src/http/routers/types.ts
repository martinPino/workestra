import type { Context } from 'hono';
import { workspaceOf, type AuthVariables } from '../auth.middleware';
import type { Services } from '../services';

/**
 * El contexto que comparten todos los routers: el principal autenticado, el bundle de la petición y los
 * servicios construidos para ella.
 */
export type RouterEnv = { Variables: AuthVariables & { services: Services } };

/**
 * El `workspaceId` autenticado de la petición: el equivalente del decorador `@Workspace()`. Sale del
 * principal validado, NUNCA de una cabecera o query que el cliente controle.
 */
export const ws = (c: Context<RouterEnv>): string => workspaceOf(c.get('user'));
