import { describe, it, expect } from 'vitest';
import { listSentryProjects, pollSentryIssues, getSentryIssueLatestEvent } from './sentry-api';

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

describe('listSentryProjects', () => {
  it('mapea a «orgSlug/projectSlug» y ordena por nombre', async () => {
    const res = await listSentryProjects({
      token: 'tok',
      fetchFn: async (url, init) => {
        expect(url).toContain('/projects/');
        expect(init?.headers?.authorization).toBe('Bearer tok');
        return { ok: true, status: 200, json: async () => [
          { slug: 'web', name: 'Web', organization: { slug: 'acme' } },
          { slug: 'api', name: 'API', organization: { slug: 'acme' } },
        ] };
      },
    });
    expect(res.projects).toEqual([
      { id: 'acme/api', name: 'API' },
      { id: 'acme/web', name: 'Web' },
    ]);
  });

  it('descarta filas sin org/slug y en error devuelve []', async () => {
    const bad = await listSentryProjects({ token: 't', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
    expect(bad.projects).toEqual([]);
    const partial = await listSentryProjects({ token: 't', fetchFn: ok([{ slug: 'x' }, { organization: { slug: 'o' } }]) });
    expect(partial.projects).toEqual([]);
  });
});

describe('pollSentryIssues', () => {
  const issues = [
    { id: '1', shortId: 'WEB-1', title: 'viejo', firstSeen: '2026-01-01T00:00:00Z', level: 'error', count: '3', culprit: 'a', permalink: 'p1' },
    { id: '2', shortId: 'WEB-2', title: 'nuevo', firstSeen: '2026-01-03T00:00:00Z', level: 'error', count: '1', culprit: 'b', permalink: 'p2' },
  ];

  it('solo devuelve issues con firstSeen posterior al cursor y avanza newSince', async () => {
    const res = await pollSentryIssues({
      token: 't',
      project: 'acme/web',
      sinceIso: '2026-01-02T00:00:00Z',
      fetchFn: async (url) => {
        expect(url).toContain('/projects/acme/web/issues/');
        expect(url).toContain('sort=new');
        return { ok: true, status: 200, json: async () => issues };
      },
    });
    expect(res.issues.map((i) => i.id)).toEqual(['2']);
    expect(res.newSince).toBe('2026-01-03T00:00:00Z');
  });

  it('en error NO avanza el cursor (reintenta el mismo lote)', async () => {
    const res = await pollSentryIssues({ token: 't', project: 'o/p', sinceIso: 'C', fetchFn: async () => ({ ok: false, status: 500, json: async () => [] }) });
    expect(res).toEqual({ issues: [], newSince: 'C' });
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
