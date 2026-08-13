import type { ExecutionEvent } from '@core/contracts';
import { currentToken } from './auth';

/**
 * Se suscribe al stream de una ejecución y reenvía cada `ExecutionEvent`. Devuelve una función para
 * desconectar.
 *
 * Habla WebSocket NATIVO contra el Durable Object de la ejecución, no socket.io: un DO no entiende el
 * protocolo de socket.io (handshake propio, reconexión, framing), solo WebSocket estándar.
 *
 * El JWT viaja en el SUBPROTOCOLO (`bearer, <token>`) porque la API `WebSocket` del navegador no deja
 * fijar cabeceras. No va en el query string a propósito: la URL acabaría en logs de acceso e
 * historiales, y ahí un token de sesión es una credencial filtrada.
 *
 * El catch-up del stream durable lo sirve el propio DO al aceptar la conexión, igual que hacía el
 * gateway al conceder la suscripción.
 */
export function subscribeExecution(
  apiUrl: string,
  executionId: string,
  onEvent: (e: ExecutionEvent) => void,
): () => void {
  const url = `${apiUrl.replace(/^http/, 'ws')}/executions/${encodeURIComponent(executionId)}/stream`;
  const socket = new WebSocket(url, ['bearer', currentToken() ?? '']);

  socket.onmessage = (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(String(ev.data)) as ExecutionEvent);
    } catch {
      /* mensaje que no es un evento: se ignora, como hacía el gateway */
    }
  };

  return () => socket.close();
}
