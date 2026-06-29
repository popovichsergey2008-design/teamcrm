import { io, Socket } from 'socket.io-client';
import { tokens } from './api';

/**
 * Единый socket-клиент с реконнектом. Авторизуется access-токеном при handshake
 * (тот же JWT, что и REST). Same-origin: URL не указываем — берётся origin страницы.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 800,
    auth: (cb) => cb({ token: tokens.access }),
  });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
