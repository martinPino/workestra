import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AnalyticsBatchSchema, EventNameSchema, EntityTypeSchema, type AnalyticsRange } from '@core/contracts';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import type { JwtPayload } from '../auth/auth.service';
import { AnalyticsService } from './analytics.service';
import { PlatformAdminGuard, PlatformAdminService } from './platform-admin.guard';

type AuthedReq = { user: JwtPayload };

/**
 * INGESTA (M84). La ruta se llama `/ingest` y no `/analytics` a propósito: las listas de bloqueo de
 * anuncios cazan por nombre cualquier URL que contenga «analytics», «track» o «collect», y un usuario
 * con un bloqueador puesto desaparecería entero de las métricas sin que nadie se enterase.
 */
@Controller('ingest')
export class IngestController {
  constructor(private readonly svc: AnalyticsService) {}

  /**
   * 202: aceptado. El navegador no espera resultado —manda y sigue—, así que devolver el detalle no
   * aporta nada y sí invitaría a que el cliente reintentase por cosas que no son suyas.
   */
  @Post()
  @HttpCode(202)
  async ingest(@Body() body: unknown, @Workspace() workspaceId: string, @Req() req: AuthedReq) {
    const parsed = AnalyticsBatchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Lote inválido.');
    const res = await this.svc.ingest(parsed.data, workspaceId, req.user.sub);
    return { accepted: res.accepted };
  }
}

/**
 * PANEL. Dos capas de permiso que comprueban cosas DISTINTAS y hacen falta las dos:
 *  - `analytics:read` (OWNER/ADMIN) dice quién puede ver analítica. No es un permiso de tenant.
 *  - el filtro por workspace, que sale siempre de la sesión verificada.
 * Y encima, `?scope=all` (cruzar todos los clientes) exige además ser administrador de PLATAFORMA.
 */
@Controller('insights')
@UseGuards(ScopesGuard)
@RequireScopes('analytics:read')
export class InsightsController {
  constructor(
    private readonly svc: AnalyticsService,
    private readonly admin: PlatformAdminService,
  ) {}

  /** Qué puede ver quien pregunta. El nav del front se apoya en esto; la API lo exige igual. */
  @Get('me')
  me(@Req() req: AuthedReq) {
    return { platformAdmin: this.admin.isAdmin(req.user.sub) };
  }

  @Get('overview')
  overview(@Query() q: Record<string, string>, @Workspace() ws: string, @Req() req: AuthedReq) {
    return this.svc.overview(this.range(q, ws, req));
  }

  @Get('entities')
  entities(@Query() q: Record<string, string>, @Workspace() ws: string, @Req() req: AuthedReq) {
    const name = EventNameSchema.safeParse(q.name);
    const entityType = EntityTypeSchema.safeParse(q.entityType);
    if (!name.success || !entityType.success) throw new BadRequestException('Evento o tipo de entidad desconocido.');
    return this.svc.entities({ ...this.range(q, ws, req), name: name.data, entityType: entityType.data });
  }

  @Get('features')
  features(@Query() q: Record<string, string>, @Workspace() ws: string, @Req() req: AuthedReq) {
    return this.svc.features(this.range(q, ws, req));
  }

  @Get('retention')
  retention(@Query() q: Record<string, string>, @Workspace() ws: string, @Req() req: AuthedReq) {
    const cohortDays = Math.min(90, Math.max(1, Number(q.cohortDays) || 30));
    return this.svc.retention({ ...this.range(q, ws, req), cohortDays });
  }

  @Get('search')
  search(@Query() q: Record<string, string>, @Workspace() ws: string, @Req() req: AuthedReq) {
    return this.svc.search(this.range(q, ws, req));
  }

  /**
   * Embudo. Los pasos vienen del cliente pero SOLO pueden ser nombres del catálogo cerrado: así el
   * panel es flexible sin que nadie pueda colar SQL ni inventarse cardinalidad.
   */
  @Get('funnel')
  funnel(@Query() q: Record<string, string>, @Workspace() ws: string, @Req() req: AuthedReq) {
    const steps = (q.steps ?? '').split(',').map((s) => EventNameSchema.safeParse(s.trim()));
    if (steps.length < 2 || steps.some((s) => !s.success)) throw new BadRequestException('Pasos del embudo inválidos.');
    const windowMinutes = Math.min(1440, Math.max(1, Number(q.windowMinutes) || 60));
    return this.svc.funnel({
      ...this.range(q, ws, req),
      steps: steps.map((s) => (s as { success: true; data: never }).data),
      windowMinutes,
    });
  }

  /**
   * Construye la ventana. Aquí se decide el tenant, y es el punto donde un error se convierte en fuga
   * entre clientes: `ALL` solo se alcanza siendo administrador de plataforma; en cualquier otro caso se
   * usa el workspace de la sesión verificada, nunca algo que venga en la query.
   */
  private range(q: Record<string, string>, ws: string, req: AuthedReq): AnalyticsRange {
    const all = q.scope === 'all';
    if (all && !this.admin.isAdmin(req.user.sub)) throw new BadRequestException('Ámbito no disponible.');
    const to = q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to) : new Date();
    const days = Math.min(180, Math.max(1, Number(q.days) || 30));
    const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from) : new Date(to.getTime() - days * 86_400_000);
    return {
      workspaceId: all ? 'ALL' : ws,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: Math.min(200, Math.max(1, Number(q.limit) || 20)),
    };
  }
}

/** Ruta separada solo para lo que EXIGE ser administrador de plataforma de forma explícita. */
@Controller('insights/platform')
@UseGuards(ScopesGuard, PlatformAdminGuard)
@RequireScopes('analytics:read')
export class PlatformInsightsController {
  constructor(private readonly svc: AnalyticsService) {}

  /** Resumen cruzando TODOS los workspaces. El guard de plataforma es la única puerta. */
  @Get('overview')
  overview(@Query() q: Record<string, string>) {
    const to = new Date();
    const days = Math.min(180, Math.max(1, Number(q.days) || 30));
    return this.svc.overview({
      workspaceId: 'ALL',
      from: new Date(to.getTime() - days * 86_400_000).toISOString(),
      to: to.toISOString(),
      limit: Math.min(200, Math.max(1, Number(q.limit) || 20)),
    });
  }
}
