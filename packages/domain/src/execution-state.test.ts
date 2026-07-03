import { describe, it, expect } from 'vitest';
import type { ExecutionEvent } from '@core/contracts';
import { reduceExecution, reduceExecutionEvent, initialExecutionState } from './execution-state';

const V = 1 as const;
const ev = (
  seq: number,
  partial: { type: ExecutionEvent['type'] } & Record<string, unknown>,
): ExecutionEvent =>
  ({ schemaVersion: V, executionId: 'e1', at: '2026-07-02T00:00:00.000Z', seq, ...partial }) as ExecutionEvent;

describe('ExecutionStateReducer', () => {
  it('deriva el estado final de un stream completo', () => {
    const events: ExecutionEvent[] = [
      ev(0, { type: 'execution.queued' }),
      ev(1, { type: 'execution.started' }),
      ev(2, { type: 'node.started', nodeKey: 'a', stepKey: 'e1:a:1' }),
      ev(3, { type: 'node.succeeded', nodeKey: 'a', stepKey: 'e1:a:1' }),
      ev(4, { type: 'node.started', nodeKey: 'b', stepKey: 'e1:b:1' }),
      ev(5, { type: 'node.failed', nodeKey: 'b', stepKey: 'e1:b:1', error: 'boom' }),
      ev(6, { type: 'execution.failed', error: 'boom' }),
    ];
    const state = reduceExecution(events);
    expect(state.status).toBe('FAILED');
    expect(state.nodes.a.status).toBe('succeeded');
    expect(state.nodes.b.status).toBe('failed');
    expect(state.nodes.b.error).toBe('boom');
    expect(state.error).toBe('boom');
    expect(state.lastSeq).toBe(6);
  });

  it('es determinista (mismo input => mismo output)', () => {
    const events: ExecutionEvent[] = [
      ev(0, { type: 'execution.started' }),
      ev(1, { type: 'node.started', nodeKey: 'a', stepKey: 's' }),
      ev(2, { type: 'node.succeeded', nodeKey: 'a', stepKey: 's' }),
      ev(3, { type: 'execution.succeeded' }),
    ];
    expect(reduceExecution(events)).toEqual(reduceExecution(events));
  });

  it('proyecta el nodo Humano en ESPERA y lo reanuda tras aprobar (M5-B)', () => {
    const events: ExecutionEvent[] = [
      ev(0, { type: 'execution.started' }),
      ev(1, { type: 'node.started', nodeKey: 'approve', stepKey: 'e1:approve:1' }),
      ev(2, { type: 'human.requested', nodeKey: 'approve', reviewId: 'r1', reason: 'Aprobar', expiresAt: '' }),
      ev(3, { type: 'execution.status', status: 'WAITING_HUMAN' }),
    ];
    const paused = reduceExecution(events);
    expect(paused.status).toBe('WAITING_HUMAN');
    expect(paused.nodes.approve.status).toBe('waiting');

    // Tras aprobar: el nodo re-ejecuta (node.started → running → succeeded) y la ejecución termina.
    const resumed = reduceExecution([
      ...events,
      ev(4, { type: 'human.resolved', nodeKey: 'approve', reviewId: 'r1', approved: true, resolvedBy: 'u', decision: 'ok' }),
      ev(5, { type: 'node.started', nodeKey: 'approve', stepKey: 'e1:approve:1' }),
      ev(6, { type: 'node.succeeded', nodeKey: 'approve', stepKey: 'e1:approve:1' }),
      ev(7, { type: 'execution.succeeded' }),
    ]);
    expect(resumed.nodes.approve.status).toBe('succeeded');
    expect(resumed.status).toBe('SUCCEEDED');
  });

  it('un rechazo humano lleva la ejecución a FAILED', () => {
    const state = reduceExecution([
      ev(0, { type: 'execution.status', status: 'WAITING_HUMAN' }),
      ev(1, { type: 'human.resolved', nodeKey: 'approve', reviewId: 'r1', approved: false, resolvedBy: 'u', decision: 'no' }),
    ]);
    expect(state.status).toBe('FAILED');
  });

  it('ignora eventos duplicados o fuera de orden (seq <= lastSeq)', () => {
    let s = initialExecutionState();
    s = reduceExecutionEvent(s, ev(0, { type: 'execution.started' }));
    s = reduceExecutionEvent(s, ev(1, { type: 'node.started', nodeKey: 'a', stepKey: 's' }));
    const stale = reduceExecutionEvent(s, ev(1, { type: 'node.failed', nodeKey: 'a', stepKey: 's', error: 'x' }));
    expect(stale).toBe(s); // sin cambios
    expect(stale.nodes.a.status).toBe('running');
  });
});
