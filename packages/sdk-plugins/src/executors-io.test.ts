import { describe, it, expect } from 'vitest';
import { emptyContext } from '@core/contracts';
import { evalCondition, ConditionNodeExecutor } from './executors-io';

describe('Condition executor (evaluador seguro)', () => {
  it('evalúa comparaciones sobre el contexto', () => {
    const ctx = { ...emptyContext(), variables: { count: 5, name: 'ada' } };
    expect(evalCondition('variables.count > 0', ctx)).toBe(true);
    expect(evalCondition('variables.count >= 5', ctx)).toBe(true);
    expect(evalCondition('variables.count < 3', ctx)).toBe(false);
    expect(evalCondition('variables.name == ada', ctx)).toBe(true);
    expect(evalCondition('variables.missing == 1', ctx)).toBe(false);
    expect(evalCondition('true', ctx)).toBe(true);
    expect(evalCondition('nonsense', ctx)).toBe(false);
  });

  it('soporta Y (&&), O (||) y «contiene» (~) del constructor visual (M21)', () => {
    const ctx = { ...emptyContext(), variables: { count: 5, name: 'ada lovelace' } };
    expect(evalCondition('variables.count > 0 && variables.name == ada lovelace', ctx)).toBe(true);
    expect(evalCondition('variables.count > 10 && variables.name == ada lovelace', ctx)).toBe(false);
    expect(evalCondition('variables.count > 10 || variables.count < 3', ctx)).toBe(false);
    expect(evalCondition('variables.count > 10 || variables.count >= 5', ctx)).toBe(true);
    expect(evalCondition('variables.name ~ lovelace', ctx)).toBe(true);
    expect(evalCondition('variables.name ~ Lovelace', ctx)).toBe(true); // case-insensitive
    expect(evalCondition('variables.name ~ xyz', ctx)).toBe(false);
  });

  it('el executor devuelve la rama y anota el resultado en el contexto', async () => {
    const exec = new ConditionNodeExecutor();
    const res = await exec.execute({
      executionId: 'e1',
      workspaceId: 'ws1',
      nodeKey: 'c1',
      config: { expression: 'variables.x > 10' },
      context: { ...emptyContext(), variables: { x: 42 } },
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(res.control).toEqual({ kind: 'branch', handle: 'true' });
    expect(res.context.variables['condition:c1']).toBe(true);
  });

  it('persiste la decisión de flujo `flow:` para que el runner PODE la rama no tomada (M14)', async () => {
    const exec = new ConditionNodeExecutor();
    const run = (x: number) =>
      exec.execute({
        executionId: 'e', workspaceId: 'ws', nodeKey: 'c1',
        config: { expression: 'variables.x > 10' },
        context: { ...emptyContext(), variables: { x } },
        signal: new AbortController().signal, emit: () => {},
      });
    expect((await run(42)).context.variables['flow:c1']).toEqual({ handles: ['true'] });
    expect((await run(1)).context.variables['flow:c1']).toEqual({ handles: ['false'] });
  });
});
