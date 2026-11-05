import { api } from './api';
import type { Socket } from 'socket.io-client';
import { getSocket } from './socket';

/**
 * Список чатов — один на всё приложение (нагрузка 05.11).
 *
 * Раньше на КАЖДОЕ сообщение каждый участник чата перечитывал GET /chats целиком, и
 * не один раз: панель чатов справа, счётчик уведомлений и раздел «Чаты» делали это
 * каждый сам. Плюс «прочитано» кем угодно — тоже перечитывание у всех. На 300
 * сотрудниках это самый тяжёлый запрос сервера (p95 1,8 с).
 *
 * Теперь:
 * - запрос один на всех: одновременные вызовы делят его, а вызов во время запроса
 *   ставит ровно один повтор после;
 * - новое сообщение правит список на месте (последняя строка, счётчик, порядок) — без
 *   запроса. Полный запрос — только когда чат незнакомый (новый), при новом/удалённом
 *   чате, своём «прочитано» и переподключении.
 */

export interface FeedChat {
  id: string | number;
  unread?: number;
  lastBody?: string | null;
  lastAuthor?: string | null;
  lastAt?: string | null;
  favorite?: boolean;
  [key: string]: unknown;
}

interface IncomingMessage {
  chatId: string;
  message: {
    author_id?: string | number | null; author_name?: string | null; body?: string | null;
    file_name?: string | null; created_at?: string; thread_root_id?: string | number | null; also_in_channel?: boolean;
  };
}

let list: FeedChat[] | null = null;
let inflight: Promise<FeedChat[]> | null = null;
let again = false;
let me: string | null = null;
let open: string | null = null;
let wiredOn: Socket | null = null;
const subs = new Set<(l: FeedChat[]) => void>();

function publish(next: FeedChat[]): void {
  list = next;
  for (const fn of subs) fn(next);
}

/** Последний известный список (может быть null до первого запроса). */
export function chatsSnapshot(): FeedChat[] | null {
  return list;
}

/** Подписка на список; сразу отдаёт текущий, если он уже есть. */
export function subscribeChats(fn: (l: FeedChat[]) => void): () => void {
  wire();
  subs.add(fn);
  if (list) fn(list);
  return () => { subs.delete(fn); };
}

/** Чей это клиент и какой чат открыт на экране — чтобы своё и открытое не считать непрочитанным. */
export function setChatsViewer(userId: string | null, openChatId: string | null): void {
  me = userId;
  open = openChatId;
}

/** Перечитать список: один запрос на всех вызывающих. */
export function loadChats(): Promise<FeedChat[]> {
  wire();
  if (inflight) { again = true; return inflight; }
  inflight = (api.listChats() as Promise<FeedChat[]>)
    .then((l) => { publish(l); return l; })
    .finally(() => {
      inflight = null;
      if (again) { again = false; void loadChats(); }
    });
  return inflight;
}

/** Сообщение пришло — правим список на месте. false — чат незнакомый, нужен полный запрос. */
export function applyChatMessage(p: IncomingMessage): boolean {
  if (!list) return false;
  const i = list.findIndex((c) => String(c.id) === String(p.chatId));
  if (i < 0) return false;
  const m = p.message ?? {};
  // ответ из ветки в ленту чата не попадает — ни в превью, ни в счётчик (как на сервере)
  if (m.thread_root_id && !m.also_in_channel) return true;
  const prev = list[i];
  const mine = !!m.author_id && !!me && String(m.author_id) === me;
  const onScreen = !!open && String(p.chatId) === open && typeof document !== 'undefined' && !document.hidden;
  const counts = !!m.author_id && !mine && !onScreen;
  const next: FeedChat = {
    ...prev,
    lastBody: m.body?.trim() ? m.body : (m.file_name ? `Файл: ${m.file_name}` : prev.lastBody ?? null),
    lastAuthor: m.author_name ?? prev.lastAuthor ?? null,
    lastAt: m.created_at ?? new Date().toISOString(),
    unread: counts ? (Number(prev.unread) || 0) + 1 : prev.unread,
  };
  // наверх своей группы: избранное всегда выше остальных (как сортирует сервер)
  const rest = list.filter((_, j) => j !== i);
  const firstPlain = rest.findIndex((c) => !c.favorite);
  const at = next.favorite ? 0 : (firstPlain < 0 ? rest.length : firstPlain);
  publish([...rest.slice(0, at), next, ...rest.slice(at)]);
  return true;
}

/** Своё «прочитано» — счётчик чата в ноль сразу, не дожидаясь запроса. */
export function markChatReadLocal(chatId: string): void {
  if (!list) return;
  const i = list.findIndex((c) => String(c.id) === String(chatId));
  if (i < 0 || !list[i].unread) return;
  publish(list.map((c, j) => (j === i ? { ...c, unread: 0 } : c)));
}

/** Одна подписка на сокет на всё приложение — иначе каждый слушатель правил бы счётчик заново. */
function wire(): void {
  const socket = getSocket();
  if (wiredOn === socket) return;
  // новый сокет — значит, вышли и вошли (может, другим человеком): прежний список не наш
  if (wiredOn) { list = null; inflight = null; again = false; }
  wiredOn = socket;
  socket.on('chat.message', (p: IncomingMessage) => { if (!applyChatMessage(p)) void loadChats(); });
  for (const ev of ['chat.created', 'chat.removed', 'chat.self-read', 'chat.message_deleted', 'chat.updated']) {
    socket.on(ev, () => { void loadChats(); });
  }
  socket.on('connect', () => { if (list) void loadChats(); });
}
