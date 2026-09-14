import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { api } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { CHATS_CHANGED } from '../../lib/notifications';
import { presenceKind, presenceLabel } from '../../lib/presence';
import { stampLabel } from '../../lib/chat-text';
import type { SearchResults } from '../../types';

/** Строка списка чатов — то, что отдаёт GET /chats (см. ChatsPage). */
export interface BarChat {
  id: string;
  kind: string;
  title: string | null;
  peerId: string | null;
  peerOnline: boolean;
  peerLastSeen?: string | null;
  peerStatus?: 'busy' | 'away' | null;
  avatarUrl?: string | null;
  unread: number;
  lastBody: string | null;
  lastAuthor: string | null;
  lastAt: string | null;
  favorite?: boolean;
}

interface BarUser { id: string; fullName: string; avatarUrl?: string | null; isActive?: boolean }

/**
 * Chat Bar — узкая панель справа во всех разделах CRM (ТЗ-5, этап 1).
 *
 * Зачем: написать коллеге не должно означать «уйти из задачи в мессенджер и потом
 * искать дорогу назад». Свёрнутый — аватары с непрочитанным, развёрнутый — имена,
 * статусы и последнее сообщение. Нажатие открывает переписку окном ПОВЕРХ текущей
 * страницы, а не вместо неё.
 *
 * Данные — те же, что у раздела «Чаты & Миты» (`/chats`), плюс присутствие; свои
 * таблицы Chat Bar не заводит. Обновляется по тем же событиям сокета, что и раздел.
 */
export function ChatBar({ expanded, onToggle, onOpenChat, onOpenAi, onNewChat, currentUserId, onCallUserIds, activeChatId }: {
  expanded: boolean;
  onToggle: () => void;
  onOpenChat: (chatId: string) => void;
  onOpenAi: () => void;
  onNewChat: () => void;
  currentUserId: string;
  /** Кто сейчас в созвоне — у него подпись «на мите». */
  onCallUserIds: Set<string>;
  activeChatId: string | null;
}) {
  const [chats, setChats] = useState<BarChat[]>([]);
  const [users, setUsers] = useState<BarUser[]>([]);
  const [presence, setPresence] = useState<Map<string, { online: boolean; lastSeenAt: string | null; status: 'busy' | 'away' | null }>>(new Map());
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  /* Задачи ищутся на сервере — их тысячи, и держать их в панели незачем. Чат задачи
     открывается тем же окном, что и обычный: одна история с карточкой (ТЗ-5, этап 3). */
  const [taskHits, setTaskHits] = useState<SearchResults['tasks']>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setTaskHits([]); return; }
    const t = window.setTimeout(() => {
      api.search(q).then((r) => setTaskHits(r.tasks.slice(0, 6))).catch(() => setTaskHits([]));
    }, 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback(() => {
    api.listChats().then((list) => setChats(list as BarChat[])).catch(() => undefined);
    api.presence().then((rows) => setPresence(new Map(rows.map((r) => [String(r.userId), r])))).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    api.listUsers().then((u) => setUsers(u.filter((x: BarUser) => x.isActive !== false))).catch(() => undefined);
  }, [load]);

  // Те же события, что двигают список в разделе. Присутствие приходит своими.
  useEffect(() => {
    const socket = getSocket();
    let timer: number | null = null;
    // Сообщения летят пачками — перечитываем один раз на пачку, а не на каждое.
    const soon = () => { if (timer) return; timer = window.setTimeout(() => { timer = null; load(); }, 400); };
    const onStatus = (p: { userId: string; status: 'busy' | 'away' | null }) => {
      setPresence((prev) => {
        const next = new Map(prev);
        const row = next.get(String(p.userId)) ?? { online: false, lastSeenAt: null, status: null };
        next.set(String(p.userId), { ...row, status: p.status });
        return next;
      });
    };
    const onOnline = (on: boolean) => (p: { userId: string }) => {
      setPresence((prev) => {
        const next = new Map(prev);
        const row = next.get(String(p.userId)) ?? { online: false, lastSeenAt: null, status: null };
        next.set(String(p.userId), { ...row, online: on, lastSeenAt: on ? row.lastSeenAt : new Date().toISOString() });
        return next;
      });
    };
    const online = onOnline(true);
    const offline = onOnline(false);
    for (const ev of ['chat.message', 'chat.read', 'chat.created', 'chat.removed', 'chat.message_deleted']) socket.on(ev, soon);
    socket.on('user.status.changed', onStatus);
    socket.on('user.online', online);
    socket.on('user.offline', offline);
    socket.on('connect', load);
    window.addEventListener(CHATS_CHANGED, soon);
    return () => {
      for (const ev of ['chat.message', 'chat.read', 'chat.created', 'chat.removed', 'chat.message_deleted']) socket.off(ev, soon);
      socket.off('user.status.changed', onStatus);
      socket.off('user.online', online);
      socket.off('user.offline', offline);
      socket.off('connect', load);
      window.removeEventListener(CHATS_CHANGED, soon);
      if (timer) window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => { if (expanded && query) searchRef.current?.focus(); }, [expanded, query]);

  const presenceOf = (chat: BarChat) => {
    if (!chat.peerId) return null;
    const p = presence.get(String(chat.peerId));
    return {
      online: p?.online ?? chat.peerOnline,
      status: p?.status ?? chat.peerStatus ?? null,
      lastSeenAt: p?.lastSeenAt ?? chat.peerLastSeen ?? null,
      onCall: onCallUserIds.has(String(chat.peerId)),
    };
  };

  const pinned = useMemo(() => chats.filter((c) => c.favorite), [chats]);
  const recent = useMemo(
    () => chats
      .filter((c) => !c.favorite)
      .sort((a, b) => new Date(b.lastAt ?? 0).getTime() - new Date(a.lastAt ?? 0).getTime())
      .slice(0, 14),
    [chats],
  );
  const totalUnread = chats.reduce((n, c) => n + (Number(c.unread) || 0), 0);

  /* Поиск — по чатам и по людям сразу: человек ищет «Глеб», а не «диалог с Глебом». */
  const q = query.trim().toLowerCase();
  const found = useMemo(() => {
    if (q.length < 1) return null;
    const peerIds = new Set(chats.filter((c) => c.peerId).map((c) => String(c.peerId)));
    const chatHits = chats.filter((c) => (c.title ?? '').toLowerCase().includes(q));
    // Сотрудники без диалога: нажатие заведёт его само — без шага «создать чат».
    const userHits = users.filter((u) => String(u.id) !== String(currentUserId)
      && !peerIds.has(String(u.id)) && u.fullName.toLowerCase().includes(q));
    return { chatHits, userHits };
  }, [q, chats, users, currentUserId]);

  const openUser = async (userId: string) => {
    try {
      const chat = await api.openDm(userId);
      setQuery('');
      onOpenChat(String(chat.id));
      load();
    } catch { /* сеть моргнула — человек нажмёт ещё раз */ }
  };

  const row = (c: BarChat) => {
    const p = presenceOf(c);
    const kind = p ? presenceKind(p) : null;
    const isActive = String(c.id) === String(activeChatId);
    return (
      <button
        key={c.id}
        className={`bar-chat${isActive ? ' active' : ''}${c.unread > 0 ? ' unread' : ''}`}
        onClick={() => onOpenChat(String(c.id))}
        title={expanded ? undefined : `${c.title ?? 'Чат'}${c.unread ? ` · ${c.unread} непрочитанных` : ''}`}
      >
        <span className="bar-avatar">
          <Avatar path={c.avatarUrl ?? null} fallback={c.kind === 'dm' ? (c.title?.[0]?.toUpperCase() ?? '?') : '#'} className="avatar-sm" />
          {kind && <span className={`bar-dot bar-dot-${kind}`} aria-hidden="true" />}
          {!expanded && c.unread > 0 && <span className="bar-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
        </span>
        {expanded && (
          <span className="bar-chat-main">
            <span className="bar-chat-top">
              <span className="bar-chat-title">{c.title ?? 'Чат'}</span>
              {c.lastAt && <span className="bar-chat-time">{stampLabel(c.lastAt).replace(/^сегодня /, '')}</span>}
            </span>
            <span className="bar-chat-sub">
              {p ? <span className={`bar-status bar-status-${kind}`}>{presenceLabel(p)}</span> : null}
              {c.lastBody && (
                <span className="bar-chat-last">
                  {p ? ' · ' : ''}{c.kind !== 'dm' && c.lastAuthor ? `${c.lastAuthor}: ` : ''}{c.lastBody}
                </span>
              )}
            </span>
          </span>
        )}
        {expanded && c.unread > 0 && <span className="bar-badge bar-badge-inline">{c.unread > 99 ? '99+' : c.unread}</span>}
      </button>
    );
  };

  return (
    <aside className={`chat-bar${expanded ? ' expanded' : ''}`} aria-label="Чаты">
      <div className="bar-top">
        <button className="bar-icon" onClick={onToggle} title={expanded ? 'Свернуть панель чатов' : 'Развернуть панель чатов'} aria-label={expanded ? 'Свернуть панель чатов' : 'Развернуть панель чатов'}>
          <Icon name={expanded ? 'chevron-right' : 'chevron-left'} size={16} />
          {expanded && <span className="bar-label">Чаты</span>}
        </button>
        <button className="bar-icon" onClick={expanded ? undefined : onToggle} title={totalUnread ? `Непрочитанных: ${totalUnread}` : 'Непрочитанных нет'} aria-label="Непрочитанные">
          <span className="bar-avatar">
            <Icon name="bell" size={16} />
            {totalUnread > 0 && <span className="bar-badge">{totalUnread > 99 ? '99+' : totalUnread}</span>}
          </span>
          {expanded && <span className="bar-label">{totalUnread ? `Непрочитанных: ${totalUnread}` : 'Всё прочитано'}</span>}
        </button>
        <button className="bar-icon" onClick={onOpenAi} title="Спросить AI" aria-label="Спросить AI">
          <Icon name="sparkles" size={16} />
          {expanded && <span className="bar-label">AI</span>}
        </button>
      </div>

      {expanded && (
        <div className="bar-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            className="bar-search-input"
            placeholder="Найти человека или чат"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label="Поиск по чатам и людям"
          />
        </div>
      )}

      <div className="bar-list">
        {found ? (
          <>
            {found.chatHits.length === 0 && found.userHits.length === 0 && taskHits.length === 0 && <div className="bar-empty">Ничего не нашлось</div>}
            {found.chatHits.length > 0 && <div className="bar-section">Чаты</div>}
            {found.chatHits.map(row)}
            {found.userHits.length > 0 && <div className="bar-section">Сотрудники</div>}
            {found.userHits.map((u) => {
              const p = presence.get(String(u.id));
              const pr = { online: p?.online ?? false, status: p?.status ?? null, lastSeenAt: p?.lastSeenAt ?? null, onCall: onCallUserIds.has(String(u.id)) };
              const kind = presenceKind(pr);
              return (
                <button key={u.id} className="bar-chat" onClick={() => openUser(String(u.id))} title="Написать">
                  <span className="bar-avatar">
                    <Avatar path={u.avatarUrl ?? null} fallback={u.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
                    <span className={`bar-dot bar-dot-${kind}`} aria-hidden="true" />
                  </span>
                  <span className="bar-chat-main">
                    <span className="bar-chat-title">{u.fullName}</span>
                    <span className={`bar-status bar-status-${kind}`}>{presenceLabel(pr)}</span>
                  </span>
                </button>
              );
            })}
            {taskHits.length > 0 && <div className="bar-section">Задачи</div>}
            {taskHits.map((t) => (
              <button key={t.id} className="bar-chat" onClick={() => { setQuery(''); onOpenChat(`task:${t.id}`); }} title="Открыть чат задачи">
                <span className="bar-avatar"><span className="bar-task-mark">#</span></span>
                <span className="bar-chat-main">
                  <span className="bar-chat-title">#{t.id} · {t.title}</span>
                  <span className="bar-chat-sub"><span className="bar-chat-last">{t.closed ? 'завершена' : t.column_name}{t.project_name ? ` · ${t.project_name}` : ''}</span></span>
                </span>
              </button>
            ))}
          </>
        ) : (
          <>
            {pinned.length > 0 && (expanded ? <div className="bar-section">Закреплённые</div> : <div className="bar-rule" />)}
            {pinned.map(row)}
            {recent.length > 0 && (expanded ? <div className="bar-section">Последние</div> : <div className="bar-rule" />)}
            {recent.map(row)}
            {chats.length === 0 && expanded && <div className="bar-empty">Чатов пока нет — найдите человека выше</div>}
          </>
        )}
      </div>

      <div className="bar-bottom">
        {!expanded && (
          <button className="bar-icon" onClick={onToggle} title="Поиск по чатам и людям" aria-label="Поиск по чатам и людям">
            <Icon name="search" size={16} />
          </button>
        )}
        <button className="bar-icon" onClick={onNewChat} title="Новый чат — группа или канал" aria-label="Новый чат">
          <Icon name="plus" size={16} />
          {expanded && <span className="bar-label">Новый чат</span>}
        </button>
      </div>
    </aside>
  );
}
