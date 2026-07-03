import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { JwtPayload } from './auth.service';

/**
 * Inyecta el `workspaceId` AUTENTICADO (del JWT), NO de una cabecera/query que el cliente controle.
 * Es la única fuente de verdad del tenant para acotar consultas y validar propiedad de recursos.
 */
export const Workspace = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
  const ws = req.user?.workspaceId;
  if (!ws) throw new InternalServerErrorException('Falta workspaceId en el token autenticado.');
  return ws;
});
