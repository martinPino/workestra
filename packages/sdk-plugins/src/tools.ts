import type { ITool } from '@core/contracts';

/**
 * Catálogo de tools NO PELIGROSAS (M3). Tools peligrosas (shell, filesystem, docker, k8s…) NO se
 * habilitan hasta que M8a aporte sandbox. HTTP se restringe por allowlist de hosts.
 */

export class MockTool implements ITool {
  readonly key = 'mock';
  readonly idempotent = true;
  async invoke(input: unknown): Promise<unknown> {
    return { tool: 'mock', echoed: input };
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export class HttpTool implements ITool {
  readonly key = 'http';
  readonly idempotent = false;
  constructor(private readonly allowlist: string[] = []) {}

  async invoke(input: unknown): Promise<unknown> {
    const { url, method = 'GET' } = (input ?? {}) as { url?: string; method?: string };
    if (!url) return { error: 'url requerida' };
    const host = hostOf(url);
    if (this.allowlist.length > 0 && !this.allowlist.includes(host)) {
      return { error: `host fuera del allowlist: ${host}`, allowlist: this.allowlist };
    }
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(8000) });
      return { status: res.status, ok: res.ok, bodyPreview: (await res.text()).slice(0, 400) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ITool>();

  register(tool: ITool): this {
    this.tools.set(tool.key, tool);
    return this;
  }

  get(key: string): ITool | undefined {
    return this.tools.get(key);
  }

  keys(): string[] {
    return [...this.tools.keys()];
  }
}
