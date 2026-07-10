import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { listSentryProjects, pollSentryIssues, getSentryIssueLatestEvent, verifySentryWebhookSignature, parseSentryIssueWebhook } from './sentry-api';

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

describe('listSentryProjects', () => {
  it('descubre orgs y lista proyectos EN LA REGIÓN de cada una (UE → de.sentry.io)', async () => {
    const calls: string[] = [];
    const res = await listSentryProjects({
      token: 'tok',
      fetchFn: async (url, init) => {
        calls.push(url);
        expect(init?.headers?.authorization).toBe('Bearer tok');
        if (url.includes('/organizations/?')) {
          // Silo de control: la org está en la UE (regionUrl = de.sentry.io).
          return { ok: true, status: 200, json: async () => [{ slug: 'acme', links: { regionUrl: 'https://de.sentry.io' } }] };
        }
        return { ok: true, status: 200, json: async () => [{ slug: 'web', name: 'Web' }, { slug: 'api', name: 'API' }] };
      },
    });
    // Los proyectos se piden a la región de la org, no a sentry.io.
    expect(calls.some((u) => u.startsWith('https://de.sentry.io/api/0/organizations/acme/projects/'))).toBe(true);
    expect(res.projects).toEqual([
      { id: 'acme/api', name: 'API' },
      { id: 'acme/web', name: 'Web' },
    ]);
  });

  it('sin regionUrl usa sentry.io; en error de orgs devuelve []', async () => {
    const usRes = await listSentryProjects({
      token: 't',
      fetchFn: async (url) =>
        url.includes('/organizations/?')
          ? { ok: true, status: 200, json: async () => [{ slug: 'o' }] }
          : { ok: url.startsWith('https://sentry.io/api/0/organizations/o/projects/'), status: 200, json: async () => [{ slug: 'p', name: 'P' }] },
    });
    expect(usRes.projects).toEqual([{ id: 'o/p', name: 'P' }]);
    const bad = await listSentryProjects({ token: 't', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    expect(bad.projects).toEqual([]);
  });
});

describe('pollSentryIssues', () => {
  const issues = [
    { id: '1', shortId: 'WEB-1', title: 'viejo', firstSeen: '2026-01-01T00:00:00Z', level: 'error', count: '3', culprit: 'a', permalink: 'p1' },
    { id: '2', shortId: 'WEB-2', title: 'nuevo', firstSeen: '2026-01-03T00:00:00Z', level: 'error', count: '1', culprit: 'b', permalink: 'p2' },
  ];

  it('resuelve la región (UE) y solo devuelve issues nuevos, avanzando newSince', async () => {
    const res = await pollSentryIssues({
      token: 't',
      project: 'acme/web',
      sinceIso: '2026-01-02T00:00:00Z',
      fetchFn: async (url) => {
        if (url.includes('/organizations/acme/')) {
          return { ok: true, status: 200, json: async () => ({ slug: 'acme', links: { regionUrl: 'https://de.sentry.io' } }) };
        }
        // Los issues se piden a la región de la org.
        expect(url).toBe('https://de.sentry.io/api/0/projects/acme/web/issues/?query=is%3Aunresolved&sort=new&limit=25');
        return { ok: true, status: 200, json: async () => issues };
      },
    });
    expect(res.issues.map((i) => i.id)).toEqual(['2']);
    expect(res.newSince).toBe('2026-01-03T00:00:00Z');
  });

  it('en error de issues NO avanza el cursor (reintenta el mismo lote)', async () => {
    const res = await pollSentryIssues({
      token: 't',
      project: 'o/p',
      sinceIso: 'C',
      fetchFn: async (url) =>
        url.includes('/organizations/o/')
          ? { ok: true, status: 200, json: async () => ({ slug: 'o' }) }
          : { ok: false, status: 500, json: async () => [] },
    });
    expect(res).toEqual({ issues: [], newSince: 'C' });
  });
});

describe('verifySentryWebhookSignature', () => {
  const secret = 'shhh';
  const body = JSON.stringify({ action: 'created' });
  const sig = createHmac('sha256', secret).update(body).digest('hex');

  it('acepta la firma correcta y rechaza la incorrecta / vacía', () => {
    expect(verifySentryWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifySentryWebhookSignature(body, sig, 'otro')).toBe(false);
    expect(verifySentryWebhookSignature(body, 'deadbeef', secret)).toBe(false);
    expect(verifySentryWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifySentryWebhookSignature(body, sig, '')).toBe(false);
  });
});

describe('parseSentryIssueWebhook', () => {
  it('extrae action, org/proyecto (de web_url) e issue', () => {
    const payload = {
      action: 'created',
      installation: { uuid: 'inst-1' },
      data: {
        issue: {
          id: '42',
          shortId: 'BACK-1',
          title: 'TypeError: x',
          culprit: 'render',
          level: 'error',
          firstSeen: '2026-01-01T00:00:00Z',
          web_url: 'https://sentry.io/organizations/acme/issues/42/',
          project: { id: '9', name: 'Backend', slug: 'backend' },
        },
      },
    };
    const r = parseSentryIssueWebhook(payload);
    expect(r.action).toBe('created');
    expect(r.project).toBe('acme/backend');
    expect(r.issue).toMatchObject({ id: '42', shortId: 'BACK-1', title: 'TypeError: x', level: 'error', projectSlug: 'backend' });
  });

  it('project = null si no puede derivar la org', () => {
    const r = parseSentryIssueWebhook({ action: 'resolved', data: { issue: { id: '1', project: { slug: 'p' } } } });
    expect(r.action).toBe('resolved');
    expect(r.project).toBeNull();
  });
});

describe('getSentryIssueLatestEvent', () => {
  it('aplana la excepción a stacktrace y recoge breadcrumbs', async () => {
    const event = {
      eventID: 'ev1',
      message: 'boom',
      entries: [
        { type: 'exception', data: { values: [{ type: 'TypeError', value: 'x is undefined', stacktrace: { frames: [{ function: 'render', filename: 'app.tsx', lineNo: 42 }] } }] } },
        { type: 'breadcrumbs', data: { values: [{ category: 'http', level: 'info', message: 'GET /api' }] } },
      ],
    };
    const res = (await getSentryIssueLatestEvent({ token: 't', issueId: '2', fetchFn: ok(event) })) as Record<string, unknown>;
    expect(res.eventId).toBe('ev1');
    expect(String(res.stacktrace)).toContain('TypeError: x is undefined');
    expect(String(res.stacktrace)).toContain('at render (app.tsx:42)');
    expect(res.breadcrumbs).toEqual(['http info: GET /api']);
  });
});
