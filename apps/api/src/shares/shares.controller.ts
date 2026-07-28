import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CreateShareRequestSchema } from '@core/contracts';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { Public } from '../auth/public.decorator';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import type { JwtPayload } from '../auth/auth.service';
import { SharesService } from './shares.service';

type AuthedReq = { user: JwtPayload };

/**
 * Endpoints de «compartir por enlace» (M85). Dos mundos:
 *  - Rutas del DUEÑO (crear/listar/revocar/importar): exigen JWT; el tenant sale de @Workspace() (JWT verificado).
 *  - Lectura PÚBLICA del enlace (`GET /shares/:token`): @Public() (sin sesión) + rate-limit, para que cualquiera
 *    con el enlace vea el snapshot sanitizado. Se localiza por el hash del token, único globalmente.
 *
 * Un solo controlador sin prefijo porque las rutas viven en dos árboles (`/workflows/:id/share` y `/shares/...`).
 */
@Controller()
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  /** Crea (o previsualiza con `dryRun`) el enlace. Muta/expone el flujo → workflow:write (no para VIEWER). */
  @Post('workflows/:id/share')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  create(@Param('id') id: string, @Body() body: unknown, @Workspace() ws: string, @Req() req: AuthedReq) {
    const parsed = CreateShareRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return this.shares.createShare(id, ws, req.user.sub, parsed.data);
  }

  /** Enlaces del workspace (vista segura, sin hash ni snapshot) para que el dueño los gestione. */
  @Get('shares')
  list(@Workspace() ws: string) {
    return this.shares.list(ws);
  }

  /** Lectura pública del enlace. Sin JWT (el importador aún no tiene sesión) + rate-limit anti-abuso. */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Get('shares/:token')
  preview(@Param('token') token: string) {
    return this.shares.preview(token);
  }

  /**
   * Registra la importación. Requiere sesión: @Workspace() da el tenant del importador, con el que el contador
   * deduplica (una cuenta cuenta una vez). La búsqueda y el bump corren en modo sistema dentro del servicio.
   */
  @UseGuards(AuthRateLimitGuard)
  @Post('shares/:token/import')
  import(@Param('token') token: string, @Workspace() ws: string) {
    return this.shares.importShare(token, ws);
  }

  /** Revoca el enlace. A un no dueño se le responde 404 (no confirmamos que exista fuera de su workspace). */
  @Delete('shares/:token')
  revoke(@Param('token') token: string, @Workspace() ws: string) {
    return this.shares.revoke(token, ws);
  }
}
