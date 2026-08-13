import { describe, it, expect } from 'vitest';
import { WebCryptoTokenSigner } from '../auth/token-signer';
import { InMemoryIdentityStore, InMemoryAuthRepository, InMemoryTeamRepository, ConsoleEmailAdapter, hashPassword } from '@core/infra';
import { AuthService, AccountDisabledError } from '../auth/auth.service';
import { TeamService } from './team.service';
import type { PersistenceBundle } from '../persistence/bundle';

async function setup() {
  const store = new InMemoryIdentityStore();
  const auth = new InMemoryAuthRepository(store);
  const team = new InMemoryTeamRepository(store);
  const bundle = { auth, team, email: new ConsoleEmailAdapter() } as unknown as PersistenceBundle;
  const authSvc = new AuthService(new WebCryptoTokenSigner('t'), bundle);
  const svc = new TeamService(bundle, authSvc);
  const owner = await auth.createAccount({ email: 'owner@t.com', passwordHash: await hashPassword('ownerpass1'), name: 'Owner' });
  // Une a un miembro/administrador vía el flujo real invitar→aceptar; devuelve su userId.
  const join = async (email: string, role: 'ADMIN' | 'EDITOR' | 'VIEWER', password = 'password1') => {
    const { acceptUrl } = await svc.invite('owner@t.com', { email, role });
    const token = acceptUrl.split('/invite/')[1];
    const s = await svc.accept(token, { name: email.split('@')[0], password });
    return s.user.id;
  };
  return { svc, auth, authSvc, owner, join };
}

describe('TeamService — reglas de gestión (M74)', () => {
  it('lista el equipo tras invitar y aceptar', async () => {
    const { svc, join } = await setup();
    await join('admin@t.com', 'ADMIN');
    await join('member@t.com', 'EDITOR');
    const team = await svc.list('owner@t.com');
    expect(team.members).toHaveLength(3);
    expect(team.members.map((m) => m.role).sort()).toEqual(['ADMIN', 'EDITOR', 'OWNER']);
  });

  it('un ADMIN gestiona a un MIEMBRO pero NO al propietario ni a sí mismo', async () => {
    const { svc, join } = await setup();
    const adminId = await join('admin@t.com', 'ADMIN');
    const memberId = await join('member@t.com', 'EDITOR');
    // admin puede cambiar/cerrar a un miembro
    await expect(svc.updateMember('admin@t.com', memberId, { role: 'VIEWER' })).resolves.toMatchObject({ role: 'VIEWER' });
    await expect(svc.updateMember('admin@t.com', memberId, { disabled: true })).resolves.toMatchObject({ disabledAt: expect.anything() });
    // …pero no a sí mismo
    await expect(svc.updateMember('admin@t.com', adminId, { disabled: true })).rejects.toThrow(/propia cuenta/);
  });

  it('NADIE puede modificar ni cerrar al propietario', async () => {
    const { svc, join, owner } = await setup();
    await join('admin@t.com', 'ADMIN');
    await expect(svc.updateMember('admin@t.com', owner.id, { role: 'EDITOR' })).rejects.toThrow(/propietario/);
    await expect(svc.updateMember('admin@t.com', owner.id, { disabled: true })).rejects.toThrow(/propietario/);
  });

  it('solo el propietario gestiona a otros ADMINs; un ADMIN no puede', async () => {
    const { svc, join } = await setup();
    await join('admin1@t.com', 'ADMIN');
    const admin2Id = await join('admin2@t.com', 'ADMIN');
    // admin1 NO puede tocar a admin2
    await expect(svc.updateMember('admin1@t.com', admin2Id, { role: 'EDITOR' })).rejects.toThrow(/administradores/);
    // el propietario SÍ
    await expect(svc.updateMember('owner@t.com', admin2Id, { role: 'EDITOR' })).resolves.toMatchObject({ role: 'EDITOR' });
  });

  it('solo el propietario puede invitar administradores', async () => {
    const { svc, join } = await setup();
    await join('admin@t.com', 'ADMIN');
    await expect(svc.invite('admin@t.com', { email: 'x@t.com', role: 'ADMIN' })).rejects.toThrow(/propietario/);
    // pero sí puede invitar miembros
    await expect(svc.invite('admin@t.com', { email: 'y@t.com', role: 'EDITOR' })).resolves.toHaveProperty('acceptUrl');
  });

  it('un miembro (EDITOR) no puede gestionar el equipo', async () => {
    const { svc, join } = await setup();
    await join('member@t.com', 'EDITOR');
    await expect(svc.list('member@t.com')).rejects.toThrow(/permiso/);
    await expect(svc.invite('member@t.com', { email: 'z@t.com', role: 'VIEWER' })).rejects.toThrow(/permiso/);
  });

  it('cerrar la cuenta BLOQUEA el login; reactivarla lo restaura', async () => {
    const { svc, authSvc, join } = await setup();
    const memberId = await join('member@t.com', 'EDITOR', 'micontraseña');
    expect(await authSvc.login({ email: 'member@t.com', password: 'micontraseña' })).not.toBeNull();
    await svc.updateMember('owner@t.com', memberId, { disabled: true });
    await expect(authSvc.login({ email: 'member@t.com', password: 'micontraseña' })).rejects.toBeInstanceOf(AccountDisabledError);
    await svc.updateMember('owner@t.com', memberId, { disabled: false });
    expect(await authSvc.login({ email: 'member@t.com', password: 'micontraseña' })).not.toBeNull();
  });

  it('no se puede invitar a un email que YA tiene cuenta (no podría aceptar)', async () => {
    const { svc, auth } = await setup();
    await auth.createAccount({ email: 'ya@existe.com', passwordHash: await hashPassword('x'), name: 'Ya' });
    await expect(svc.invite('owner@t.com', { email: 'ya@existe.com', role: 'EDITOR' })).rejects.toThrow(/ya tiene una cuenta/);
  });

  it('una invitación no se puede aceptar dos veces', async () => {
    const { svc } = await setup();
    const { acceptUrl } = await svc.invite('owner@t.com', { email: 'once@t.com', role: 'EDITOR' });
    const token = acceptUrl.split('/invite/')[1];
    await svc.accept(token, { name: 'Once', password: 'password1' });
    await expect(svc.accept(token, { name: 'Again', password: 'password1' })).rejects.toThrow();
  });
});
