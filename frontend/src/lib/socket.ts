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
    const retry = () => {
      if (socket !== s || s.connected) return;
      // токенов нет — человек вышел; ждём, пока войдёт снова (в этой или соседней вкладке)
      if (!tokens.refresh) { window.setTimeout(retry, 5_000); return; }
      refreshAccess().catch(() => undefined).finally(() => { if (socket === s && tokens.refresh) s.connect(); });
    };
    window.setTimeout(retry, pause);
  });
  socket = s;
  return s;
}

/**
 * Вошли снова в той же вкладке — поднять сокет.
 *
 * Сессия кончилась (или вход упал, как 29.10) — сервер выгоняет сокет, а переподключение
 * выше останавливается: токенов нет. После нового входа его никто не включал, и до
 * перезагрузки страницы не было ни «в сети», ни живых сообщений. Экземпляр тот же:
 * на нём уже висят слушатели разделов, новый сокет их бы потерял.
 */
export function reconnectSocket() {
  if (socket && !socket.connected) socket.connect();
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
