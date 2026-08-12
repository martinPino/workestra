import type { ExecutionContext, ExecutionEvent } from '@core/contracts';

/**
 * `ExecutionRoom`: un Durable Object por ejecución. Sustituye a TRES piezas del despliegue de Railway —
 * el `TelemetryGateway` de socket.io, el canal `exec:*` de Redis pub/sub y el `RedisEventBridge` que los
 * unía— porque aquí el bus y el gateway son el mismo objeto. Además guarda el checkpoint del contexto,
 * que era el `RedisContextStore`.
 *
 * Lo que se gana no es solo quitar saltos: un DO es de UN hilo y serializa sus peticiones, así que el
 * Workflow que ejecuta y la API que reanuda una pausa humana no pueden pisarse a mitad de un checkpoint.
 * En Redis eso era un `SET` de último-en-llegar-gana.
 *
 * AUTORIZACIÓN: este objeto NO autentica. Un DO solo es alcanzable desde un Worker con su binding, y el
 * Worker ya validó el JWT y comprobó que la ejecución es del workspace del token ANTES de pasar el
 * socket. Mantener esa comprobación fuera es deliberado: es la misma frontera que tenía `handleConnection`
 * en el gateway, donde el guard HTTP global tampoco cubría los WebSockets.
 */

const CONTEXT_KEY = 'ctx';

/**
 * Interfaz mínima del `DurableObjectState` que usa esta clase. Se tipa a mano por la misma razón que en
 * `@core/infra/cloudflare`: `@cloudflare/workers-types` declara globals que chocan con `@types/node`, y
 * este paquete todavía compila con los de Node mientras exista el despliegue de Nest.
 */
export interface DurableStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    deleteAll(): Promise<void>;
  };
  /** Sockets que sobrevivieron a la hibernación del objeto. */
  getWebSockets(): WebSocketLike[];
  /** Acepta el socket con hibernación: el DO puede descargarse de memoria sin cerrar la conexión. */
  acceptWebSocket(ws: WebSocketLike): void;
}

export interface WebSocketLike {
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

export class ExecutionRoom {
  constructor(private readonly state: DurableStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/context' && request.method === 'GET') {
      const ctx = await this.state.storage.get<ExecutionContext>(CONTEXT_KEY);
      // 404 = ejecución sin checkpoint todavía. Es el caso normal del primer nodo, y el adaptador lo
      // traduce a `emptyContext()`; devolver 200 con null obligaría a distinguirlo en el cliente.
      return ctx === undefined ? new Response(null, { status: 404 }) : Response.json(ctx);
    }

    if (url.pathname === '/context' && request.method === 'POST') {
      await this.state.storage.put(CONTEXT_KEY, await request.json());
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/events' && request.method === 'POST') {
      const event = (await request.json()) as ExecutionEvent;
      this.broadcast(event);
      // Si la ejecución terminó, el objeto ya no tiene nada que guardar. Esto es lo que sustituye al
      // TTL de Redis: allí el checkpoint caducaba solo, aquí hay que cerrarlo explícitamente o el
      // almacenamiento del DO se queda ocupado para siempre.
      if (event.type === 'execution.succeeded' || event.type === 'execution.failed') {
        await this.state.storage.deleteAll();
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws') {
      return this.acceptWebSocket(request);
    }

    return new Response(null, { status: 404 });
  }

  /**
   * Acepta un WebSocket con HIBERNACIÓN. Es la diferencia práctica con socket.io: una consola abierta
   * durante una ejecución larga (o una pausa humana de horas) no mantiene nada en memoria — el DO se
   * descarga y se despierta cuando llega el siguiente evento. Con el gateway de Nest, cada consola
   * abierta ocupaba una conexión en el proceso del API.
   */
  private acceptWebSocket(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Se esperaba una petición de upgrade a WebSocket.', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocketLike, WebSocketLike];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /** Difunde a los suscritos. Un socket muerto no puede tumbar el fan-out ni la ejecución. */
  private broadcast(event: ExecutionEvent): void {
    const message = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        /* socket cerrándose: el resto de suscriptores debe recibirlo igual */
      }
    }
  }
}

/** Globals de la plataforma que este fichero usa y `@types/node` no declara. */
declare const WebSocketPair: { new (): { 0: WebSocketLike; 1: WebSocketLike } };
