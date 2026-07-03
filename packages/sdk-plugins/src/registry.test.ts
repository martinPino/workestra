import { describe, it, expect } from 'vitest';
import type { INodeExecutor } from '@core/contracts';
import { NodeExecutorRegistry, createDefaultNodeRegistry } from './index';

describe('NodeExecutorRegistry', () => {
  it('registra y resuelve ejecutores por tipo', () => {
    const reg = createDefaultNodeRegistry();
    expect(reg.has('trigger')).toBe(true);
    expect(reg.get('end')?.type).toBe('end');
    expect(reg.get('agent')).toBeUndefined();
  });

  it('rechaza el doble registro del mismo tipo', () => {
    const reg = new NodeExecutorRegistry();
    const ex: INodeExecutor = {
      type: 'tool',
      async execute(c) {
        return { context: c.context, control: { kind: 'continue' } };
      },
    };
    reg.register(ex);
    expect(() => reg.register(ex)).toThrow();
  });
});
