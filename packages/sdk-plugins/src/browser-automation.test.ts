import { describe, it, expect } from 'vitest';
import {
  MockBrowserEngine,
  createBrowserEngine,
  defaultEngineName,
  registeredEngines,
  BrowserSessionManager,
  BrowserAutomationService,
  checkNavigation,
  ACTION_PARAM_SCHEMAS,
  BROWSER_ACTIONS,
} from './browser-automation';
import { BrowserTool } from './browser-tool';
import { ToolAuthorizationService } from './tool-authorization';

const perm = { allowHosts: [], denyHosts: [], maxSessionMs: 60_000, maxActionsPerSession: 100 };

/** Afirma que la acción fue OK y devuelve el resultado tipado (los tests inspeccionan campos concretos). */
function ok<T = Record<string, unknown>>(r: unknown): T {
  const res = r as { ok: boolean; error?: string };
  if (!res.ok) throw new Error(`esperaba ok:true, fue: ${res.error}`);
  return r as T;
}

describe('Browser Automation — motor intercambiable (M71)', () => {
  it('la fábrica devuelve mock por defecto y registra playwright + browserbase', () => {
    expect(defaultEngineName()).toBe('mock');
    expect(createBrowserEngine().name).toBe('mock');
    expect(createBrowserEngine('mock').live).toBe(false);
    // Motor desconocido → degradación segura a mock (nunca rompe).
    expect(createBrowserEngine('inexistente' as never).name).toBe('mock');
    expect(registeredEngines()).toEqual(expect.arrayContaining(['mock', 'playwright', 'browserbase']));
    // Los motores reales existen y se marcan `live`; el mock no.
    expect(createBrowserEngine('browserbase').name).toBe('browserbase');
    expect(createBrowserEngine('browserbase').live).toBe(true);
    expect(createBrowserEngine('playwright').live).toBe(true);
  });

  it('Browserbase falla claro si no está configurado (sin tocar la red)', async () => {
    const prev = { k: process.env.BROWSERBASE_API_KEY, p: process.env.BROWSERBASE_PROJECT_ID };
    delete process.env.BROWSERBASE_API_KEY;
    delete process.env.BROWSERBASE_PROJECT_ID;
    try {
      await expect(createBrowserEngine('browserbase').launch({})).rejects.toThrow(/no está configurado/i);
    } finally {
      if (prev.k) process.env.BROWSERBASE_API_KEY = prev.k;
      if (prev.p) process.env.BROWSERBASE_PROJECT_ID = prev.p;
    }
  });

  it('MockBrowserEngine exige abrir antes de actuar y registra las acciones', async () => {
    const e = new MockBrowserEngine();
    await expect(e.goto('https://example.com')).rejects.toThrow(/no está abierto/);
    await e.launch({});
    const r = await e.goto('https://example.com/login');
    expect(r).toEqual({ url: 'https://example.com/login', status: 200 });
    await e.click('#submit');
    await e.fill('#email', 'a@b.com');
    expect(await e.extractText()).toContain('example.com');
    expect((await e.screenshot()).length).toBeGreaterThan(0);
    await e.setCookies([{ name: 'sid', value: 'x' }]);
    expect(await e.getCookies()).toHaveLength(1);
    expect(e.actions()).toEqual(expect.arrayContaining(['goto https://example.com/login', 'click #submit']));
  });
});

describe('Browser Automation — esquemas y seguridad', () => {
  it('cubre exactamente las 25 acciones y valida parámetros', () => {
    expect(BROWSER_ACTIONS).toHaveLength(25);
    for (const a of BROWSER_ACTIONS) expect(ACTION_PARAM_SCHEMAS[a]).toBeDefined();
    expect(ACTION_PARAM_SCHEMAS.browser_goto.safeParse({ sessionId: 's', url: 'no-es-url' }).success).toBe(false);
    expect(ACTION_PARAM_SCHEMAS.browser_goto.safeParse({ sessionId: 's', url: 'https://ok.com' }).success).toBe(true);
    expect(ACTION_PARAM_SCHEMAS.browser_click.safeParse({ sessionId: 's', selector: '' }).success).toBe(false);
  });

  it('bloquea dominios internos/metadata y respeta el allowlist', () => {
    expect(checkNavigation('http://localhost/x', perm).ok).toBe(false);
    expect(checkNavigation('http://169.254.169.254/latest', perm).ok).toBe(false);
    expect(checkNavigation('https://example.com', perm).ok).toBe(true);
    const allow = { ...perm, allowHosts: ['example.com'] };
    expect(checkNavigation('https://example.com/a', allow).ok).toBe(true);
    expect(checkNavigation('https://evil.com', allow).ok).toBe(false);
  });
});

describe('Browser Automation — sesiones', () => {
  const managerWith = (over: Partial<typeof perm> = {}) => {
    let n = 0;
    return new BrowserSessionManager({
      createEngine: () => new MockBrowserEngine(),
      policy: { ...perm, ...over },
      now: () => 1000 + n++, // avanza 1ms por lectura (determinista)
      genId: (() => {
        let i = 0;
        return () => `s${++i}`;
      })(),
    });
  };

  it('abre sesiones independientes y las cierra por ejecución', async () => {
    const m = managerWith();
    const a = await m.open({ executionId: 'e1' }, (e) => e.launch({}));
    await m.open({ executionId: 'e2' }, (e) => e.launch({}));
    expect(m.count()).toBe(2);
    expect(a.id).not.toBe('');
    await m.closeByExecution('e1');
    expect(m.count()).toBe(1);
    await m.closeAll();
    expect(m.count()).toBe(0);
  });

  it('cierra la sesión al superar el nº máximo de acciones', async () => {
    const m = managerWith({ maxActionsPerSession: 2 });
    const s = await m.open({}, (e) => e.launch({}));
    await m.use(s.id);
    await m.use(s.id);
    await expect(m.use(s.id)).rejects.toThrow(/nº máximo de acciones/);
    expect(m.count()).toBe(0); // se cerró
  });

  it('usar una sesión inexistente lanza', async () => {
    const m = managerWith();
    await expect(m.use('nope')).rejects.toThrow(/inexistente/);
  });
});

describe('Browser Automation — servicio (round-trip completo)', () => {
  const service = () => {
    let i = 0;
    return new BrowserAutomationService({
      createEngine: () => new MockBrowserEngine(),
      policy: perm,
      genId: () => `sess${++i}`,
    });
  };

  it('open → goto → extract → screenshot → close', async () => {
    const svc = service();
    const open = ok<{ sessionId: string }>(await svc.run('browser_open', { url: 'https://example.com/login' }, { executionId: 'e1' }));
    expect(open).toMatchObject({ ok: true, sessionId: 'sess1', engine: 'mock', live: false, url: 'https://example.com/login' });
    const sessionId = open.sessionId;

    expect(await svc.run('browser_click', { sessionId, selector: '#login' })).toEqual({ ok: true });
    const text = ok<{ text: string }>(await svc.run('browser_extract_text', { sessionId }));
    expect(text.text).toContain('example.com');
    const shot = ok<{ bytes: number }>(await svc.run('browser_take_screenshot', { sessionId, fullPage: true }));
    expect(shot.bytes).toBeGreaterThan(0);
    expect(await svc.run('browser_close', { sessionId })).toEqual({ ok: true, closed: true });
  });

  it('rechaza parámetros inválidos, acciones desconocidas y navegación prohibida', async () => {
    const svc = service();
    expect(await svc.run('browser_goto', { sessionId: 's', url: 'x' })).toMatchObject({ ok: false });
    expect(await svc.run('desconocida' as never, {})).toMatchObject({ ok: false });
    const open = ok<{ sessionId: string }>(await svc.run('browser_open', {}, {}));
    const denied = await svc.run('browser_goto', { sessionId: open.sessionId, url: 'http://localhost/admin' });
    expect(denied).toMatchObject({ ok: false });
    expect((denied as { error: string }).error).toMatch(/prohibido/i);
  });
});

describe('Browser Automation — tool de agente', () => {
  it('describe() expone el vocabulario de acciones al LLM', () => {
    const tool = new BrowserTool({ createEngine: () => new MockBrowserEngine(), policy: perm });
    const d = tool.describe();
    expect(d.description).toMatch(/navegador/i);
    const params = d.parameters as { properties: { action: { enum: string[] } } };
    expect(params.properties.action.enum).toEqual([...BROWSER_ACTIONS]);
  });

  it('invoke enruta a la acción y valida', async () => {
    let i = 0;
    const tool = new BrowserTool({ createEngine: () => new MockBrowserEngine(), policy: perm, genId: () => `t${++i}` });
    const open = (await tool.invoke({ action: 'browser_open', url: 'https://example.com' }, {})) as { ok: boolean; sessionId: string };
    expect(open.ok).toBe(true);
    const snap = (await tool.invoke({ action: 'browser_take_snapshot', sessionId: open.sessionId }, {})) as { ok: boolean; title: string };
    expect(snap.ok).toBe(true);
    expect(await tool.invoke({ action: 'no_existe' }, {})).toMatchObject({ error: expect.stringMatching(/desconocida/) });
    expect(await tool.invoke({}, {})).toMatchObject({ error: expect.stringMatching(/action/) });
  });

  it('la autorización RBAC permite «browser» a EDITOR y lo niega a VIEWER', () => {
    const authz = new ToolAuthorizationService();
    expect(authz.authorize({ role: 'EDITOR', agentTools: ['browser'], toolKey: 'browser' }).allowed).toBe(true);
    expect(authz.authorize({ role: 'VIEWER', agentTools: ['browser'], toolKey: 'browser' }).allowed).toBe(false);
    // No está en el allowlist del agente → denegada aunque el rol pudiera.
    expect(authz.authorize({ role: 'EDITOR', agentTools: ['http'], toolKey: 'browser' }).allowed).toBe(false);
  });

  it('emite un evento browser.action por acción para el replay (M72)', async () => {
    let i = 0;
    const svc = new BrowserAutomationService({ createEngine: () => new MockBrowserEngine(), policy: perm, genId: () => `s${++i}` });
    const events: Array<Record<string, unknown>> = [];
    const hooks = { emit: (e: unknown) => events.push(e as Record<string, unknown>), nodeKey: 'qa' };

    const open = ok<{ sessionId: string }>(await svc.run('browser_open', { url: 'https://example.com' }, {}, hooks));
    await svc.run('browser_click', { sessionId: open.sessionId, selector: '#buy' }, {}, hooks);
    await svc.run('browser_goto', { sessionId: open.sessionId, url: 'http://localhost/admin' }, {}, hooks); // prohibido → ok:false

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'browser.action', action: 'browser_open', ok: true, nodeKey: 'qa', target: 'https://example.com' });
    expect(events[1]).toMatchObject({ type: 'browser.action', action: 'browser_click', ok: true, target: '#buy' });
    expect(events[2]).toMatchObject({ type: 'browser.action', action: 'browser_goto', ok: false });
    expect(typeof events[2].error).toBe('string');
  });

  it('sin nodeKey NO emite la clave (para no pisar la del runner en el replay)', async () => {
    const svc = new BrowserAutomationService({ createEngine: () => new MockBrowserEngine(), policy: perm, genId: () => 'sx' });
    const events: Array<Record<string, unknown>> = [];
    await svc.run('browser_open', { url: 'https://example.com' }, {}, { emit: (e) => events.push(e as Record<string, unknown>) });
    expect(events[0]).not.toHaveProperty('nodeKey');
  });

  it('persiste la captura en el IFileStore inyectado y expone su id (M72)', async () => {
    let i = 0;
    const store: Array<{ ws: string; name: string; bytes: number }> = [];
    const artifacts = {
      put: async (kind: string, bytes: Uint8Array, meta: { name: string; owner: { workspaceId?: string } }) => {
        store.push({ ws: meta.owner.workspaceId ?? '', name: `${kind}:${meta.name}`, bytes: bytes.length });
        return { id: `f${store.length}` };
      },
    };
    const svc = new BrowserAutomationService({ createEngine: () => new MockBrowserEngine(), policy: perm, genId: () => `s${++i}`, artifacts });
    const open = ok<{ sessionId: string }>(await svc.run('browser_open', { url: 'https://example.com' }, { workspaceId: 'ws1' }));
    const shot = ok<{ screenshotFileId: string }>(await svc.run('browser_take_screenshot', { sessionId: open.sessionId }, { workspaceId: 'ws1' }));
    expect(shot.screenshotFileId).toBe('f1');
    expect(store[0]).toMatchObject({ ws: 'ws1', bytes: expect.any(Number) });
    expect(store[0].bytes).toBeGreaterThan(0);
  });
});
