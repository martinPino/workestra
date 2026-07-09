import type { AuthAccount, TeamMember, TeamInvitation } from '@core/engine';
import type { Role } from '@core/contracts';

interface MemUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
}
interface MemMembership {
  id: string;
  userId: string;
  organizationId: string;
  workspaceId: string;
  role: Role;
  disabledAt: Date | null;
}
interface MemInvitation {
  id: string;
  organizationId: string;
  workspaceId: string;
  email: string;
  role: Role;
  tokenHash: string;
  invitedByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export interface IdentitySeed {
  email: string;
  name: string;
  passwordHash: string;
  workspaceId?: string;
  organizationId?: string;
  role?: Role;
}

/**
 * Almacén de identidad en memoria (M73/M74): usuarios + organizaciones + pertenencias + invitaciones. Es la
 * fuente ÚNICA que comparten los adaptadores in-memory de auth y de equipo (dev/tests), para que crear un
 * usuario por invitación sea visible al login y viceversa. El adaptador Prisma es el equivalente durable.
 */
export class InMemoryIdentityStore {
  private readonly users = new Map<string, MemUser>();
  private readonly memberships: MemMembership[] = [];
  private readonly invitations: MemInvitation[] = [];
  private seq = 0;

  constructor(seed: IdentitySeed[] = []) {
    for (const s of seed) {
      const n = ++this.seq;
      const email = s.email.toLowerCase();
      const user: MemUser = { id: `user_${n}`, email, name: s.name, passwordHash: s.passwordHash, createdAt: new Date(0) };
      this.users.set(user.id, user);
      this.memberships.push({ id: `mem_${n}`, userId: user.id, organizationId: s.organizationId ?? `org_${n}`, workspaceId: s.workspaceId ?? `ws_${n}`, role: s.role ?? 'OWNER', disabledAt: null });
    }
  }

  private userByEmail(email: string): MemUser | undefined {
    const e = email.toLowerCase();
    for (const u of this.users.values()) if (u.email === e) return u;
    return undefined;
  }
  private primaryMembership(userId: string): MemMembership | undefined {
    const mine = this.memberships.filter((m) => m.userId === userId);
    return mine.find((m) => m.role === 'OWNER') ?? mine[0];
  }
  private accountFrom(user: MemUser, m: MemMembership): AuthAccount {
    return { id: user.id, email: user.email, name: user.name, passwordHash: user.passwordHash, workspaceId: m.workspaceId, organizationId: m.organizationId, role: m.role, disabledAt: m.disabledAt };
  }

  // ---- Auth ----
  findByEmail(email: string): AuthAccount | null {
    const user = this.userByEmail(email);
    if (!user) return null;
    const m = this.primaryMembership(user.id);
    if (!m) return null;
    return this.accountFrom(user, m);
  }

  createAccount(input: { email: string; passwordHash: string; name: string }): AuthAccount {
    const email = input.email.toLowerCase();
    if (this.userByEmail(email)) throw new Error('EMAIL_TAKEN');
    const n = ++this.seq;
    const user: MemUser = { id: `user_${n}`, email, name: input.name, passwordHash: input.passwordHash, createdAt: new Date(0) };
    this.users.set(user.id, user);
    const m: MemMembership = { id: `mem_${n}`, userId: user.id, organizationId: `org_${n}`, workspaceId: `ws_${n}`, role: 'OWNER', disabledAt: null };
    this.memberships.push(m);
    return this.accountFrom(user, m);
  }

  // ---- Team: miembros ----
  listMembers(organizationId: string): TeamMember[] {
    return this.memberships
      .filter((m) => m.organizationId === organizationId)
      .map((m) => {
        const u = this.users.get(m.userId)!;
        return { userId: u.id, email: u.email, name: u.name, role: m.role, disabledAt: m.disabledAt, joinedAt: u.createdAt };
      });
  }
  getMembership(organizationId: string, userId: string): TeamMember | null {
    const m = this.memberships.find((x) => x.organizationId === organizationId && x.userId === userId);
    if (!m) return null;
    const u = this.users.get(userId)!;
    return { userId, email: u.email, name: u.name, role: m.role, disabledAt: m.disabledAt, joinedAt: u.createdAt };
  }
  setRole(organizationId: string, userId: string, role: Role): void {
    const m = this.memberships.find((x) => x.organizationId === organizationId && x.userId === userId);
    if (m) m.role = role;
  }
  setDisabled(organizationId: string, userId: string, disabled: boolean): void {
    const m = this.memberships.find((x) => x.organizationId === organizationId && x.userId === userId);
    if (m) m.disabledAt = disabled ? new Date() : null;
  }

  // ---- Team: invitaciones ----
  listInvitations(organizationId: string): TeamInvitation[] {
    return this.invitations
      .filter((i) => i.organizationId === organizationId && !i.acceptedAt)
      .map((i) => ({ id: i.id, email: i.email, role: i.role, invitedByUserId: i.invitedByUserId, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt }));
  }
  createInvitation(input: { organizationId: string; workspaceId: string; email: string; role: Role; tokenHash: string; invitedByUserId: string; expiresAt: Date }): TeamInvitation {
    const inv: MemInvitation = { id: `inv_${++this.seq}`, ...input, email: input.email.toLowerCase(), createdAt: new Date(), acceptedAt: null };
    this.invitations.push(inv);
    return { id: inv.id, email: inv.email, role: inv.role, invitedByUserId: inv.invitedByUserId, createdAt: inv.createdAt, expiresAt: inv.expiresAt, acceptedAt: null };
  }
  revokeInvitation(organizationId: string, invitationId: string): boolean {
    const idx = this.invitations.findIndex((i) => i.id === invitationId && i.organizationId === organizationId && !i.acceptedAt);
    if (idx < 0) return false;
    this.invitations.splice(idx, 1);
    return true;
  }
  findInvitationByTokenHash(tokenHash: string): (TeamInvitation & { organizationId: string; workspaceId: string }) | null {
    const i = this.invitations.find((x) => x.tokenHash === tokenHash);
    if (!i) return null;
    return { id: i.id, email: i.email, role: i.role, invitedByUserId: i.invitedByUserId, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt, organizationId: i.organizationId, workspaceId: i.workspaceId };
  }
  acceptInvitation(input: { invitationId: string; passwordHash: string; name: string }): AuthAccount {
    const inv = this.invitations.find((i) => i.id === input.invitationId);
    if (!inv) throw new Error('INVITE_NOT_FOUND');
    if (inv.acceptedAt) throw new Error('INVITE_CONSUMED');
    if (this.userByEmail(inv.email)) throw new Error('EMAIL_TAKEN');
    const n = ++this.seq;
    const user: MemUser = { id: `user_${n}`, email: inv.email, name: input.name, passwordHash: input.passwordHash, createdAt: new Date() };
    this.users.set(user.id, user);
    const m: MemMembership = { id: `mem_${n}`, userId: user.id, organizationId: inv.organizationId, workspaceId: inv.workspaceId, role: inv.role, disabledAt: null };
    this.memberships.push(m);
    inv.acceptedAt = new Date();
    return this.accountFrom(user, m);
  }
}
