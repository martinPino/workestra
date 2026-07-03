import { io, type Socket } from 'socket.io-client';
import type { ExecutionEvent } from '@core/contracts';
import { currentToken } from './auth';

/**
 * Se conecta al TelemetryGateway, se suscribe a una ejecución y reenvía cada `ExecutionEvent`.
 * Envía el JWT de la sesión en el handshake (`auth.token`): el gateway lo exige y solo concede la
 * suscripción a ejecuciones del propio workspace (M8). Hace catch-up del stream durable al
 * suscribirse. Devuelve una función para desconectar.
 */
export function subscribeExecution(
  apiUrl: string,
  executionId: string,
  onEvent: (e: ExecutionEvent) => void,
): () => void {
  const socket: Socket = io(apiUrl, { transports: ['websocket'], auth: { token: currentToken() ?? '' } });
  socket.on('connect', () => socket.emit('subscribe', { executionId }));
  socket.on('execution.event', (e: ExecutionEvent) => onEvent(e));
  return () => socket.disconnect();
}
