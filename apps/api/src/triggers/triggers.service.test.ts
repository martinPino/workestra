import { describe, it, expect, vi, afterEach } from 'vitest';
import { UnauthorizedException } from '../http/common';
import type { TriggerBindingRecord } from '@core/engine';
import { TriggersService } from './triggers.service';
import type { PersistenceBundle } from '../persistence/bundle';
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

/** Servicio con lo justo para probar la reconciliación al borrar un flujo (conector conectado + Jira mockeado). */
function makeReconcileService(activeByConnector: Record<string, TriggerBindingRecord[]>) {
  const p = {
    connectors: { getInWorkspace: async (id: string) => ({ id, key: 'jira', status: 'connected', credentialsSecretId: `sec:${id}` }) },
    secrets: {
      get: async (_ws: string, key: string) => (key.startsWith('sec:') ? 'oauth' : key.startsWith('jira-hook:') ? 'whsec_stable' : null),
      set: async () => undefined,
    },
    triggerBindings: {
      listByConnector: async (connectorId: string) => activeByConnector[connectorId] ?? [],
      setRemoteId: async () => undefined,
    },
  } as unknown as PersistenceBundle;
  return new TriggersService(p, {} as unknown as ExecutionsService);
}

describe('TriggersService.reconcileAfterWorkflowDelete', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('reconcilia CADA sitio (cloudId) distinto del conector, no solo uno (Map por par, no por conector)', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ values: [], isLast: true }) } as unknown as Response;
    }) as unknown as typeof fetch;

    // El flujo borrado tenía dos disparadores del MISMO conector c1 en sitios de Jira distintos (X e Y);
    // tras el borrado no queda ninguno activo, así que cada sitio debe limpiarse por separado.
    const svc = makeReconcileService({ c1: [] });
    const removed: TriggerBindingRecord[] = [
      binding({ id: 'b1', params: { projectKey: 'A', cloudId: 'X' } }),
      binding({ id: 'b2', params: { projectKey: 'B', cloudId: 'Y' } }),
    ];
    await svc.reconcileAfterWorkflowDelete(removed, 'ws');

    expect(urls.some((u) => u.includes('/ex/jira/X/'))).toBe(true);
    expect(urls.some((u) => u.includes('/ex/jira/Y/'))).toBe(true);
  });
});
