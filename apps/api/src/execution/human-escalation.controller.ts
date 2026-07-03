import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Role } from '@core/contracts';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { HumanEscalationService } from './human-escalation.service';

interface ResolveBody {
  approved: boolean;
  decision?: string;
  reviewId?: string;
  resolvedBy?: string;
}

/**
 * Endpoints de escalado humano. Ambos exigen JWT (guard global) y se ACOTAN al workspace del token:
 * la lectura de revisiones y la resolución solo operan sobre ejecuciones del propio tenant. Resolver
 * exige además el scope `execution:approve` (deny-by-default): VIEWER → 403, EDITOR/ADMIN/OWNER → OK.
 */
@Controller('executions/:id')
export class HumanEscalationController {
  constructor(private readonly svc: HumanEscalationService) {}

  @Get('reviews')
  reviews(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.listReviews(id, workspaceId);
  }

  @Post('human')
  @UseGuards(ScopesGuard)
  @RequireScopes('execution:approve')
  resolve(
    @Param('id') id: string,
    @Body() body: ResolveBody,
    @Workspace() workspaceId: string,
    @Req() req: { user?: { sub?: string; role?: Role } },
  ) {
    const resolvedBy = body.resolvedBy ?? req.user?.sub ?? 'unknown';
    return this.svc.resolveReview(id, workspaceId, {
      approved: Boolean(body.approved),
      decision: body.decision,
      reviewId: body.reviewId,
      resolvedBy,
    });
  }
}
