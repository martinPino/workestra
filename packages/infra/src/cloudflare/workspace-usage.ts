import type { IWorkspaceUsageRepository } from '@core/engine';
import type { DurableObjectNamespaceLike } from './bindings';
import { WORKSPACE_USAGE, workspaceUsageName, dayKey } from './protocol';

/**
 * Contador diario de tokens LLM por workspace en un Durable Object (sustituye a
 * `RedisWorkspaceUsageRepository`, M33).
 *
 * El DO es la primitiva correcta aquí y KV NO lo es: KV es eventualmente consistente y no tiene
 * incremento atómico, así que dos nodos sumando a la vez perderían lecturas y la cuota se podría
 * rebasar. El DO serializa las escrituras, que es justo lo que daba `INCRBY` en Redis.
 */
export class DurableObjectWorkspaceUsageRepository implements IWorkspaceUsageRepository {
  constructor(private readonly ns: DurableObjectNamespaceLike) {}

  private stub(workspaceId: string) {
    return this.ns.get(this.ns.idFromName(workspaceUsageName(workspaceId)));
  }

  async add(workspaceId: string, tokens: number): Promise<number> {
    const res = await this.stub(workspaceId).fetch(WORKSPACE_USAGE.add, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: Math.max(0, Math.round(tokens)), day: dayKey() }),
    });
    if (!res.ok) throw new Error(`usage: el DO respondió ${res.status} al sumar para ${workspaceId}`);
    return (await res.json<{ total: number }>()).total;
  }

  async todayTokens(workspaceId: string): Promise<number> {
    const res = await this.stub(workspaceId).fetch(`${WORKSPACE_USAGE.today}?day=${dayKey()}`);
    if (!res.ok) throw new Error(`usage: el DO respondió ${res.status} al leer ${workspaceId}`);
    return (await res.json<{ total: number }>()).total;
  }
}
