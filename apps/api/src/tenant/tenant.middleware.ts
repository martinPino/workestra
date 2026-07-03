import { Injectable, NestMiddleware } from '@nestjs/common';

/**
 * Extrae el tenant (workspace) de la cabecera `x-workspace-id` y lo adjunta a la request.
 * El aislamiento efectivo lo garantizan el middleware de Prisma (exige workspaceId) y RLS.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, string | undefined>; workspaceId?: string | null },
    _res: unknown,
    next: () => void,
  ): void {
    req.workspaceId = req.headers['x-workspace-id'] ?? null;
    next();
  }
}
