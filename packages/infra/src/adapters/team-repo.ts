import type { PrismaClient } from '@prisma/client';
import type { ITeamRepository, TeamMember, TeamInvitation, AuthAccount } from '@core/engine';
import type { Role } from '@core/contracts';
import type { InMemoryIdentityStore } from './identity-store';

/** Gestión de equipo in-memory (M74): delega en el store de identidad compartido con el repo de auth. */
export class InMemoryTeamRepository implements ITeamRepository {
  constructor(private readonly store: InMemoryIdentityStore) {}

  async listMembers(organizationId: string): Promise<TeamMember[]> {
    return this.store.listMembers(organizationId);
  }
  async getMembership(organizationId: string, userId: string): Promise<TeamMember | null> {
    return this.store.getMembership(organizationId, userId);
  }
  async setRole(organizationId: string, userId: string, role: Role): Promise<void> {
    this.store.setRole(organizationId, userId, role);
  }
  async setDisabled(organizationId: string, userId: string, disabled: boolean): Promise<void> {
    this.store.setDisabled(organizationId, userId, disabled);
  }
  async listInvitations(organizationId: string): Promise<TeamInvitation[]> {
    return this.store.listInvitations(organizationId);
  }
  async createInvitation(input: { organizationId: string; workspaceId: string; email: string; role: Role; tokenHash: string; invitedByUserId: string; expiresAt: Date }): Promise<TeamInvitation> {
    return this.store.createInvitation(input);
  }
  async revokeInvitation(organizationId: string, invitationId: string): Promise<boolean> {
    return this.store.revokeInvitation(organizationId, invitationId);
  }
  async findInvitationByTokenHash(tokenHash: string): Promise<(TeamInvitation & { organizationId: string; workspaceId: string }) | null> {
    return this.store.findInvitationByTokenHash(tokenHash);
  }
  async acceptInvitation(input: { invitationId: string; passwordHash: string; name: string }): Promise<AuthAccount> {
    return this.store.acceptInvitation(input);
  }
}

type MembershipRow = { userId: string; role: string; disabledAt: Date | null; user: { email: string; name: string; createdAt: Date } };
type InvitationRow = { id: string; email: string; role: string; invitedByUserId: string; createdAt: Date; expiresAt: Date; acceptedAt: Date | null };

/** Gestión de equipo durable (Prisma, M74). */
export class PrismaTeamRepository implements ITeamRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private toMember(m: MembershipRow): TeamMember {
    return { userId: m.userId, email: m.user.email, name: m.user.name, role: m.role as Role, disabledAt: m.disabledAt, joinedAt: m.user.createdAt };
  }
  private toInvite(i: InvitationRow): TeamInvitation {
    return { id: i.id, email: i.email, role: i.role as Role, invitedByUserId: i.invitedByUserId, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt };
  }

  async listMembers(organizationId: string): Promise<TeamMember[]> {
    const rows = await this.prisma.membership.findMany({
      where: { organizationId, workspaceId: { not: null } },
      include: { user: { select: { email: true, name: true, createdAt: true } } },
    });
    return rows.map((r) => this.toMember(r as unknown as MembershipRow)).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  }

  async getMembership(organizationId: string, userId: string): Promise<TeamMember | null> {
    const row = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
      include: { user: { select: { email: true, name: true, createdAt: true } } },
    });
    return row ? this.toMember(row as unknown as MembershipRow) : null;
  }

  async setRole(organizationId: string, userId: string, role: Role): Promise<void> {
    await this.prisma.membership.updateMany({ where: { organizationId, userId }, data: { role } });
  }

  async setDisabled(organizationId: string, userId: string, disabled: boolean): Promise<void> {
    await this.prisma.membership.updateMany({ where: { organizationId, userId }, data: { disabledAt: disabled ? new Date() : null } });
  }

  async listInvitations(organizationId: string): Promise<TeamInvitation[]> {
    const rows = await this.prisma.invitation.findMany({ where: { organizationId, acceptedAt: null }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toInvite(r as unknown as InvitationRow));
  }

  async createInvitation(input: { organizationId: string; workspaceId: string; email: string; role: Role; tokenHash: string; invitedByUserId: string; expiresAt: Date }): Promise<TeamInvitation> {
    const row = await this.prisma.invitation.create({ data: { ...input, email: input.email.toLowerCase() } });
    return this.toInvite(row as unknown as InvitationRow);
  }

  async revokeInvitation(organizationId: string, invitationId: string): Promise<boolean> {
    const res = await this.prisma.invitation.deleteMany({ where: { id: invitationId, organizationId, acceptedAt: null } });
    return res.count > 0;
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<(TeamInvitation & { organizationId: string; workspaceId: string }) | null> {
    const row = await this.prisma.invitation.findUnique({ where: { tokenHash } });
    if (!row) return null;
    return { ...this.toInvite(row as unknown as InvitationRow), organizationId: row.organizationId, workspaceId: row.workspaceId };
  }

  async acceptInvitation(input: { invitationId: string; passwordHash: string; name: string }): Promise<AuthAccount> {
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invitation.findUnique({ where: { id: input.invitationId } });
      if (!inv) throw new Error('INVITE_NOT_FOUND');
      if (inv.acceptedAt) throw new Error('INVITE_CONSUMED');
      const existing = await tx.user.findUnique({ where: { email: inv.email } });
      if (existing) throw new Error('EMAIL_TAKEN');
      const user = await tx.user.create({ data: { email: inv.email, passwordHash: input.passwordHash, name: input.name } });
      await tx.membership.create({ data: { userId: user.id, organizationId: inv.organizationId, workspaceId: inv.workspaceId, role: inv.role } });
      await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        workspaceId: inv.workspaceId,
        organizationId: inv.organizationId,
        role: inv.role as Role,
        disabledAt: null,
      };
    });
  }
}
