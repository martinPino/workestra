import {
  OnGatewayInit,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Inject } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import type { ExecutionEvent } from '@core/contracts';
import { ExecutionEventHub } from './execution-event-hub';
import { AuthService } from '../auth/auth.service';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';

const room = (executionId: string) => `exec:${executionId}`;

/**
 * TelemetryGateway: reenvía el stream de `ExecutionEvent` (el estado lo deriva el cliente con el
 * reducer puro). AUTENTICADO Y ACOTADO POR TENANT (M8): el handshake exige un JWT válido (en
 * `auth.token`) y la suscripción solo se concede si la ejecución pertenece al workspace del token —
 * el guard HTTP global NO cubre WebSockets, así que la autorización se hace aquí explícitamente.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class TelemetryGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly hub: ExecutionEventHub,
    private readonly auth: AuthService,
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
  ) {}

  afterInit(): void {
    this.hub.onEvent((e: ExecutionEvent) => {
      this.server.to(room(e.executionId)).emit('execution.event', e);
    });
  }

  /** Autentica el handshake: sin JWT válido, se rechaza la conexión. Guarda el workspace en el socket. */
  handleConnection(socket: Socket): void {
    const token = (socket.handshake.auth?.token as string | undefined) ?? undefined;
    try {
      const payload = this.auth.verify(token ?? '');
      socket.data.workspaceId = payload.workspaceId;
    } catch {
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe')
  async onSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { executionId?: string },
  ): Promise<{ ok: boolean }> {
    const id = body?.executionId;
    const workspaceId = socket.data.workspaceId as string | undefined;
    if (!id || !workspaceId) return { ok: false };

    // Autorización por tenant: solo se suscribe (y recibe el catch-up) si la ejecución es del workspace.
    const execution = await this.p.executions.get(id);
    if (!execution || execution.workspaceId !== workspaceId) return { ok: false };

    socket.join(room(id));
    // Catch-up desde el store DURABLE (M6): tras un reinicio de la API el buffer in-memory está
    // vacío, pero el suscriptor sigue recibiendo el stream completo (el reducer deduplica por seq).
    const events = await this.p.events.list(id);
    for (const e of events) socket.emit('execution.event', e);
    return { ok: true };
  }
}
