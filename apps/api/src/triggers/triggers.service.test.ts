import { describe, it, expect } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { TriggerBindingRecord } from '@core/engine';
import { TriggersService } from './triggers.service';
import type { PersistenceBundle } from '../persistence/persistence.module';
import type { ExecutionsService } from '../execution/executions.service';

type Started = { workflowId: string; ctx: Record<string, unknown> };

function makeService(bindings: TriggerBindingRecord[], token: string | null) {
  const started: Started[] = [];
  const p = {
    triggerBindings: { listByConnector: async () => bindings },
    secrets: { get: async (_ws: string, key: string) => (key === 'jira-hook:c1' ? token : null) },
  } as unknown as PersistenceBundle;
  const executions = {
    start: async (workflowId: string, _ws: string, ctx: Record<string, unknown>) => {
      started.push({ workflowId, ctx });
      return { executionId: `e${started.length}`, status: 'RUNNING' as const };
    },
  } as unknown as ExecutionsService;
  return { svc: new TriggersService(p, executions), started };
}

const binding = (over: Partial<TriggerBindingRecord> = {}): TriggerBindingRecord => ({
  id: 't1',
  workspaceId: 'ws',
  workflowId: 'wf1',
  eventId: 'jira.issue_created',
  connectorId: 'c1',
  webhookId: 'jira:c1',
  remoteId: '1',
  params: { projectKey: 'KAN', cloudId: 'cloud' },
  active: true,
  createdAt: '',
  ...over,
});

const payload = {
  webhookEvent: 'jira:issue_created',
  issue: { key: 'KAN-9', fields: { summary: 'Hola', project: { key: 'KAN' } } },
};

describe('TriggersService.ingestJiraEvent', () => {
  it('401 uniforme si no hay bindings (no revela existencia del conector)', async () => {
    const { svc } = makeService([], 'sek');
    await expect(svc.ingestJiraEvent('c1', 'sek', payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 si el token no coincide', async () => {
    const { svc } = makeService([binding()], 'sek');
    await expect(svc.ingestJiraEvent('c1', 'malo', payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401 si el token es undefined', async () => {
    const { svc } = makeService([binding()], 'sek');
    await expect(svc.ingestJiraEvent('c1', undefined, payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('arranca el flujo que coincide (evento + proyecto) y expone ticket.key/summary', async () => {
    const { svc, started } = makeService([binding()], 'sek');
    const r = await svc.ingestJiraEvent('c1', 'sek', payload);
    expect(r.started).toHaveLength(1);
    expect(started[0].workflowId).toBe('wf1');
    const ctx = started[0].ctx as { ticket: { key: string; summary: string } };
    expect(ctx.ticket.key).toBe('KAN-9');
    expect(ctx.ticket.summary).toBe('Hola');
  });

  it('no arranca nada si el proyecto no coincide', async () => {
    const { svc, started } = makeService([binding({ params: { projectKey: 'OTRO', cloudId: 'c' } })], 'sek');
    const r = await svc.ingestJiraEvent('c1', 'sek', payload);
    expect(r.started).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it('dedupe: dos recetas al mismo flujo → una sola ejecución por evento', async () => {
    const { svc, started } = makeService([binding({ id: 'a' }), binding({ id: 'b' })], 'sek');
    const r = await svc.ingestJiraEvent('c1', 'sek', payload);
    expect(r.started).toHaveLength(1);
    expect(started).toHaveLength(1);
  });
});
