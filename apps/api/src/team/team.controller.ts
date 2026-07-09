import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { InviteMemberSchema, UpdateMemberSchema, AcceptInviteSchema } from '@core/contracts';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Public } from '../auth/public.decorator';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import type { JwtPayload } from '../auth/auth.service';
import { TeamService } from './team.service';

type AuthedReq = { user: JwtPayload };

/**
 * Endpoints de gestión de equipo (M74). Las rutas de gestión exigen el scope `team:manage` (OWNER/ADMIN);
 * las reglas finas (proteger al OWNER, admin no toca a admin, etc.) las aplica TeamService. Las rutas de
 * aceptar invitación son públicas (el invitado aún no tiene sesión) y van con rate-limit.
 */
@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @UseGuards(ScopesGuard)
  @RequireScopes('team:manage')
  list(@Req() req: AuthedReq) {
    return this.team.list(req.user.email);
  }

  @Post('invitations')
  @UseGuards(ScopesGuard)
  @RequireScopes('team:manage')
  invite(@Req() req: AuthedReq, @Body() body: unknown) {
    const parsed = InviteMemberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return this.team.invite(req.user.email, parsed.data);
  }

  @Delete('invitations/:id')
  @UseGuards(ScopesGuard)
  @RequireScopes('team:manage')
  revoke(@Req() req: AuthedReq, @Param('id') id: string) {
    return this.team.revokeInvite(req.user.email, id);
  }

  @Patch('members/:userId')
  @UseGuards(ScopesGuard)
  @RequireScopes('team:manage')
  update(@Req() req: AuthedReq, @Param('userId') userId: string, @Body() body: unknown) {
    const parsed = UpdateMemberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return this.team.updateMember(req.user.email, userId, parsed.data);
  }

  // ---- Público: aceptar una invitación (el invitado no tiene sesión todavía) ----

  @Public()
  @Get('invite/:token')
  preview(@Param('token') token: string) {
    return this.team.invitePreview(token);
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('invite/:token/accept')
  accept(@Param('token') token: string, @Body() body: unknown) {
    const parsed = AcceptInviteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return this.team.accept(token, parsed.data);
  }
}
