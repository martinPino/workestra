import { describe, it, expect } from 'vitest';
import { InMemoryApiKeyRepository } from './api-key-repo';

const mk = (over: Partial<Parameters<InMemoryApiKeyRepository['create']>[0]> = {}) => ({
  workspaceId: 'ws_1',
  userSub: 'u1',
  email: 'a@b.c',
  role: 'ADMIN' as const,
  hashedKey: 'h1',
  prefix: 'af',
  last4: 'abcd',
  label: 'k',
  ...over,
});

describe('InMemoryApiKeyRepository (M32)', () => {
  it('create → findByHash (solo activas) → revoke la oculta', async () => {
    const repo = new InMemoryApiKeyRepository();
    const rec = await repo.create(mk());
    expect(await repo.findByHash('h1')).toMatchObject({ id: rec.id, workspaceId: 'ws_1', role: 'ADMIN' });
    const rev = await repo.revoke(rec.id, 'ws_1');
    expect(rev?.revokedAt).toBeInstanceOf(Date);
    expect(await repo.findByHash('h1')).toBeNull(); // una clave revocada ya no autentica
  });

  it('revoke es deny-by-default por workspace', async () => {
    const repo = new InMemoryApiKeyRepository();
    const rec = await repo.create(mk());
    expect(await repo.revoke(rec.id, 'ws_OTRO')).toBeNull(); // no puede revocar de otro tenant
    expect(await repo.findByHash('h1')).not.toBeNull(); // sigue activa
  });

  it('listByWorkspace filtra por tenant (sin cruzar workspaces)', async () => {
    const repo = new InMemoryApiKeyRepository();
    await repo.create(mk({ hashedKey: 'h1' }));
    await repo.create(mk({ hashedKey: 'h2' }));
    await repo.create(mk({ workspaceId: 'ws_2', hashedKey: 'h3' }));
    const list = await repo.listByWorkspace('ws_1');
    expect(list).toHaveLength(2);
    expect(list.every((k) => k.workspaceId === 'ws_1')).toBe(true);
  });
});
