import { describe, it, expect } from 'vitest';
import { InMemoryWorkspaceUsageRepository } from './workspace-usage-repo';

describe('InMemoryWorkspaceUsageRepository (M33)', () => {
  it('acumula tokens del día por workspace y aísla por tenant', async () => {
    const repo = new InMemoryWorkspaceUsageRepository();
    expect(await repo.todayTokens('ws_1')).toBe(0);
    expect(await repo.add('ws_1', 100)).toBe(100);
    expect(await repo.add('ws_1', 50)).toBe(150);
    expect(await repo.todayTokens('ws_1')).toBe(150);
    // otro workspace no comparte contador
    expect(await repo.todayTokens('ws_2')).toBe(0);
    await repo.add('ws_2', 10);
    expect(await repo.todayTokens('ws_1')).toBe(150);
    expect(await repo.todayTokens('ws_2')).toBe(10);
  });

  it('ignora tokens negativos y redondea', async () => {
    const repo = new InMemoryWorkspaceUsageRepository();
    await repo.add('ws', -5);
    expect(await repo.todayTokens('ws')).toBe(0);
    await repo.add('ws', 12.7);
    expect(await repo.todayTokens('ws')).toBe(13);
  });
});
