import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '../http/common';
import { createHash, randomBytes } from 'node:crypto';
import type { InviteMemberDto, UpdateMemberDto, AcceptInviteDto, Role } from '@core/contracts';
import { hashPassword } from '@core/infra';
import type { TeamMember, AuthAccount } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { AuthService, type SessionResult } from '../auth/auth.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const appUrl = (): string => (process.env.APP_URL ?? 'https://appweb-production-1a37.up.railway.app').replace(/\/+$/, '');

/**
 * Gestión de equipo (M74). Aquí viven las REGLAS de quién puede tocar a quién:
 * - El OWNER (lead admin) no lo puede modificar ni cerrar NADIE.
 * - Nadie puede cambiar su propia cuenta (rol/estado).
 * - Un ADMIN gestiona MIEMBROS (EDITOR/VIEWER) y puede promoverlos a ADMIN, pero NO puede tocar a otro
 *   ADMIN ni invitar admins: eso es solo del OWNER.
 * El actor se resuelve de la BD por su email (autoritativo, no se fía del rol del token).
 */
@Injectable()
export class TeamService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly auth: AuthService,
  ) {}

  private async actor(email: string): Promise<AuthAccount> {
    const a = await this.p.auth.findByEmail(email);
    if (!a) throw new ForbiddenException('Sin cuenta válida.');
    if (a.disabledAt) throw new ForbiddenException('Tu cuenta está desactivada.');
    return a;
  }

  // Actor que ADEMÁS debe poder gestionar el equipo (OWNER/ADMIN). Defensa en profundidad: aunque el scope
  // `team:manage` del controller ya lo garantiza, el servicio no se fía y lo reafirma.
  private async manager(email: string): Promise<AuthAccount> {
    const a = await this.actor(email);
    if (a.role !== 'OWNER' && a.role !== 'ADMIN') throw new ForbiddenException('No tienes permiso para gestionar el equipo.');
    return a;
  }

  async list(actorEmail: string) {
    const actor = await this.manager(actorEmail);
    const [members, invitations] = await Promise.all([
      this.p.team.listMembers(actor.organizationId),
      this.p.team.listInvitations(actor.organizationId),
    ]);
    return { members, invitations, emailConfigured: this.p.email.configured, me: { userId: actor.id, role: actor.role } };
  }

  async invite(actorEmail: string, dto: InviteMemberDto) {
    const actor = await this.manager(actorEmail);
    // Solo el propietario puede crear administradores (un admin crea miembros y promueve a los existentes).
    if (dto.role === 'ADMIN' && actor.role !== 'OWNER') {
      throw new ForbiddenException('Solo el propietario puede invitar administradores.');
    }
    const email = dto.email.toLowerCase();
    const members = await this.p.team.listMembers(actor.organizationId);
    if (members.some((m) => m.email === email)) throw new ConflictException('Esa persona ya está en el equipo.');
    // En v1 la invitación crea un usuario NUEVO; si el email ya tiene cuenta (en cualquier equipo) no podría
    // aceptarla (User.email es único global) → lo rechazamos aquí en vez de crear una invitación imposible.
    if (await this.p.auth.findByEmail(email)) throw new ConflictException('Ese email ya tiene una cuenta en AgentFlow.');
    // Solo bloquea una invitación PENDIENTE y aún VIGENTE; una caducada no debe impedir volver a invitar.
    const now = Date.now();
    const existing = (await this.p.team.listInvitations(actor.organizationId)).find((i) => i.email === email && i.expiresAt.getTime() > now);
    if (existing) throw new ConflictException('Ya hay una invitación pendiente para ese email.');

    const rawToken = newToken();
    const invitation = await this.p.team.createInvitation({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      email,
      role: dto.role,
      tokenHash: sha256(rawToken),
      invitedByUserId: actor.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });

    const acceptUrl = `${appUrl()}/invite/${rawToken}`;
    // El correo de invitación va en INGLÉS (audiencia internacional del producto).
    const role = roleLabel(dto.role);
    const emailSent = await this.p.email.send({
      to: email,
      subject: "You've been invited to a team on AgentFlow",
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
  <h2 style="margin:0 0 12px;font-size:20px">You've been invited to AgentFlow</h2>
  <p style="margin:0 0 20px;color:#444;line-height:1.5">You've been invited to join a team on <strong>AgentFlow</strong> as <strong>${role}</strong>.</p>
  <p style="margin:0 0 24px"><a href="${acceptUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Accept invitation</a></p>
  <p style="margin:0 0 6px;color:#888;font-size:13px">Or paste this link into your browser:</p>
  <p style="margin:0 0 20px;font-size:13px;word-break:break-all"><a href="${acceptUrl}" style="color:#4f46e5">${acceptUrl}</a></p>
  <p style="margin:0;color:#aaa;font-size:12px">This link expires in 7 days. If you weren't expecting this, you can ignore this email.</p>
</div>`,
      text: `You've been invited to join a team on AgentFlow as ${role}. Accept your invitation and create your account: ${acceptUrl} (this link expires in 7 days). If you weren't expecting this, you can ignore this email.`,
    });
    // El enlace se devuelve SIEMPRE para poder copiarlo/compartirlo aunque no haya proveedor de correo.
    return { invitation, acceptUrl, emailSent };
  }

  async revokeInvite(actorEmail: string, invitationId: string) {
    const actor = await this.manager(actorEmail);
    const ok = await this.p.team.revokeInvitation(actor.organizationId, invitationId);
    if (!ok) throw new NotFoundException('Invitación no encontrada.');
    return { revoked: true };
  }

  async updateMember(actorEmail: string, targetUserId: string, dto: UpdateMemberDto): Promise<TeamMember> {
    const actor = await this.manager(actorEmail);
    const target = await this.p.team.getMembership(actor.organizationId, targetUserId);
    if (!target) throw new NotFoundException('Miembro no encontrado.');
    // Reglas de protección (M74):
    if (target.role === 'OWNER') throw new ForbiddenException('No se puede modificar al propietario del equipo.');
    if (target.userId === actor.id) throw new ForbiddenException('No puedes cambiar tu propia cuenta.');
    if (actor.role === 'ADMIN' && target.role === 'ADMIN') {
      throw new ForbiddenException('Solo el propietario puede gestionar a otros administradores.');
    }
    if (dto.role) await this.p.team.setRole(actor.organizationId, targetUserId, dto.role);
    if (dto.disabled !== undefined) await this.p.team.setDisabled(actor.organizationId, targetUserId, dto.disabled);
    const updated = await this.p.team.getMembership(actor.organizationId, targetUserId);
    if (!updated) throw new NotFoundException('Miembro no encontrado.');
    return updated;
  }

  // ---- Público: aceptar invitación ----

  private async liveInvite(rawToken: string) {
    const inv = await this.p.team.findInvitationByTokenHash(sha256(rawToken));
    if (!inv || inv.acceptedAt || inv.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException('La invitación no es válida o ha caducado.');
    }
    return inv;
  }

  async invitePreview(rawToken: string) {
    const inv = await this.liveInvite(rawToken);
    return { email: inv.email, role: inv.role };
  }

  async accept(rawToken: string, dto: AcceptInviteDto): Promise<SessionResult> {
    const inv = await this.liveInvite(rawToken);
    const passwordHash = await hashPassword(dto.password);
    let account: AuthAccount;
    try {
      account = await this.p.team.acceptInvitation({ invitationId: inv.id, passwordHash, name: dto.name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'EMAIL_TAKEN') throw new ConflictException('Ese email ya tiene una cuenta. Inicia sesión.');
      if (msg === 'INVITE_CONSUMED') throw new ConflictException('Esta invitación ya se había usado.');
      if (msg === 'INVITE_NOT_FOUND') throw new NotFoundException('La invitación no es válida.');
      throw e;
    }
    return this.auth.issueSession(account);
  }
}

// Etiquetas de rol EN INGLÉS (se usan solo en el correo de invitación, que va en inglés).
function roleLabel(role: Role): string {
  return { OWNER: 'Owner', ADMIN: 'Admin', EDITOR: 'Member', VIEWER: 'Viewer' }[role] ?? role;
}
