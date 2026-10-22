import { io, Socket } from 'socket.io-client';
import { refreshAccess, tokens } from './api';
import { tokenStale } from './token-exp';
import { API_ORIGIN } from './origin';

/**
 * Единый socket-клиент с реконнектом. Авторизуется access-токеном при handshake
 * (тот же JWT, что и REST). Same-origin: URL не указываем — берётся origin страницы.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  // В оболочке — на сервер API; в браузере origin не указываем, берётся со страницы.
  const s = io(API_ORIGIN || undefined, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 800,
    // просроченный токен сначала обновляем: с ним сервер выгонит сокет (#4634)
    auth: (cb) => {
      if (!tokenStale(tokens.access)) return cb({ token: tokens.access });
      refreshAccess().catch(() => undefined).finally(() => cb({ token: tokens.access }));
    },
  });
  /*
    Сервер выгнал сокет (так он отвечает на негодный токен) — socket.io после этого
    сам НЕ переподключается, и сообщения не приходили до перезагрузки страницы
    (#4634). Обновляем токен и подключаемся снова; паузу удваиваем, если выгоняют
    сразу же, чтобы не долбить сервер.
  */
  let pause = 1000;
  let since = 0;
  s.on('connect', () => { since = Date.now(); });
  s.on('disconnect', (reason) => {
    if (reason !== 'io server disconnect') return;
    pause = Date.now() - since > 10_000 ? 1000 : Math.min(pause * 2, 30_000);
    window.setTimeout(() => {
      if (socket !== s || s.connected || !tokens.refresh) return;
      refreshAccess().catch(() => undefined).finally(() => { if (socket === s && tokens.refresh) s.connect(); });
    }, pause);
  });
  socket = s;
  return s;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
