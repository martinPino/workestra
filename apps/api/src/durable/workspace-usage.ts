/**
 * `WorkspaceUsage`: un Durable Object por workspace con el contador diario de tokens LLM (M33).
 * Sustituye a la clave `usage:<ws>:<día>` de Redis.
 *
 * El DO serializa sus peticiones, así que la suma es atómica sin transacción — lo que daba `INCRBY`.
 * KV no valdría: es eventualmente consistente y no tiene incremento atómico, de modo que dos nodos
 * sumando a la vez perderían lecturas y la cuota se podría rebasar.
 *
 * El DÍA lo decide el cliente y llega en la petición: un DO puede vivir en cualquier región, y dejarle
 * calcular «hoy» haría que la cuota se resetease a horas distintas según dónde se instanciara.
 */
export interface DurableStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
    delete(key: string): Promise<boolean>;
  };
}

export class WorkspaceUsage {
  constructor(private readonly state: DurableStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/add' && request.method === 'POST') {
      const { tokens, day } = (await request.json()) as { tokens: number; day: string };
      const total = ((await this.state.storage.get<number>(day)) ?? 0) + Math.max(0, Math.round(tokens));
      await this.state.storage.put(day, total);
      await this.pruneOldDays(day);
      return Response.json({ total });
    }

    if (url.pathname === '/today' && request.method === 'GET') {
      const day = url.searchParams.get('day') ?? '';
      return Response.json({ total: (await this.state.storage.get<number>(day)) ?? 0 });
    }

    return new Response(null, { status: 404 });
  }

  /**
   * Borra los contadores de días anteriores. Es el equivalente del TTL de Redis, que aquí no existe: sin
   * esto el objeto acumularía una clave por día para siempre. Se hace al escribir —en vez de con una
   * alarm— porque un workspace que no consume tampoco necesita limpieza.
   */
  private async pruneOldDays(today: string): Promise<void> {
    const all = await this.state.storage.list<number>();
    for (const key of all.keys()) {
      if (key < today) await this.state.storage.delete(key);
    }
  }
}
