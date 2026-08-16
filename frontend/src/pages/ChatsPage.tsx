import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { useAuth } from '../state/auth';
import type { User } from '../types';

interface Chat {
  id: string; kind: 'dm' | 'group' | 'project'; title: string | null;
  peerId: string | null; peerOnline: boolean; projectId: string | null;
  unread: number; lastBody: string | null; lastAuthor: string | null; lastAt: string | null;
}
interface Message {
  id: string; author_id: string | null; author_name: string | null; body: string;
  file_id: string | null; file_name: string | null; created_at: string;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });

/**
 * Мессенджер: слева люди и группы, справа переписка. Звонок — из шапки чата,
 * то есть звонишь конкретному человеку, а не в общую комнату.
 */
export function ChatsPage({ onCall }: { onCall: (chat: { id: string; title: string; memberIds: string[] }) => void }) {
  const { user } = useAuth();
  const [chats, setChats] = useState<Chat[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [err, setErr] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(() => api.listChats().then(setChats).catch(() => undefined), []);

  useEffect(() => {
    reload();
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [reload]);

  // Новые сообщения приходят по тому же сокету, что и события досок.
  useEffect(() => {
    const socket = getSocket();
    const onMessage = (p: { chatId: string; message: Message }) => {
      if (String(p.chatId) === String(activeId)) {
        setMessages((prev) => (prev.some((m) => m.id === p.message.id) ? prev : [...prev, p.message]));
        api.markChatRead(p.chatId).catch(() => undefined);
      }
      reload();
    };
    const onDeleted = (p: { chatId: string; messageId: string }) => {
      if (String(p.chatId) === String(activeId)) setMessages((prev) => prev.filter((m) => m.id !== p.messageId));
    };
    socket.on('chat.message', onMessage);
    socket.on('chat.message_deleted', onDeleted);
    socket.on('chat.created', reload);
    return () => {
      socket.off('chat.message', onMessage);
      socket.off('chat.message_deleted', onDeleted);
      socket.off('chat.created', reload);
    };
  }, [activeId, reload]);

  const openChat = useCallback(async (id: string) => {
    setActiveId(id); setErr('');
    try {
      setMessages(await api.chatMessages(id));
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть чат'); }
  }, [reload]);

  // лента всегда прокручена вниз: читают последнее, а не начало переписки
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId) return;
    setDraft('');
    try {
      const message = await api.sendChatMessage(activeId, text);
      setMessages((prev) => [...prev, message]);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Сообщение не отправлено');
      setDraft(text); // не теряем набранное
    }
  };

  const attach = async (file: File) => {
    if (!activeId) return;
    try {
      const message = await api.sendChatFile(activeId, file, draft.trim());
      setDraft('');
      setMessages((prev) => [...prev, message]);
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Файл не отправлен'); }
  };

  const writeTo = async (userId: string) => {
    try {
      const chat = await api.openDm(userId);
      await reload();
      openChat(chat.id);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть диалог'); }
  };

  const active = chats.find((c) => String(c.id) === String(activeId)) ?? null;
  const dms = chats.filter((c) => c.kind === 'dm');
  const groups = chats.filter((c) => c.kind !== 'dm');
  // с кем ещё не переписывались — показываем ниже, чтобы можно было начать диалог
  const others = useMemo(() => {
    const known = new Set(dms.map((c) => String(c.peerId)));
    return users.filter((u) => String(u.id) !== String(user?.id) && !known.has(String(u.id)));
  }, [users, dms, user]);

  const match = (s: string | null) => !query || (s ?? '').toLowerCase().includes(query.toLowerCase());

  return (
    <div className="chats">
      <aside className="chat-list">
        <input className="input chat-search" placeholder="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} />

        {dms.filter((c) => match(c.title)).map((c) => (
          <ChatRow key={c.id} chat={c} active={String(c.id) === String(activeId)} onClick={() => openChat(c.id)} />
        ))}

        {groups.filter((c) => match(c.title)).length > 0 && <div className="chat-group-head">Группы и проекты</div>}
        {groups.filter((c) => match(c.title)).map((c) => (
          <ChatRow key={c.id} chat={c} active={String(c.id) === String(activeId)} onClick={() => openChat(c.id)} />
        ))}

        {others.filter((u) => match(u.fullName)).length > 0 && <div className="chat-group-head">Написать впервые</div>}
        {others.filter((u) => match(u.fullName)).map((u) => (
          <button key={u.id} className="chat-row" onClick={() => writeTo(u.id)}>
            <span className="avatar-xs avatar-ph">{u.fullName[0]?.toUpperCase()}</span>
            <span className="chat-row-main"><span className="chat-row-title">{u.fullName}</span></span>
          </button>
        ))}
      </aside>

      <section className="chat-view">
        {!active && <div className="muted chat-empty">Выберите, кому написать</div>}
        {active && (
          <>
            <div className="chat-head">
              <span>
                {active.kind === 'dm' && <span className={`presence ${active.peerOnline ? 'on' : ''}`} title={active.peerOnline ? 'в сети' : 'не в сети'} />}
                <b>{active.title ?? 'Чат'}</b>
                {active.kind === 'project' && <span className="badge badge-muted" style={{ marginLeft: 6 }}>проект</span>}
              </span>
              <button
                className="btn btn-sm"
                title="Позвонить участникам чата"
                onClick={() => onCall({
                  id: active.id,
                  title: active.title ?? 'Чат',
                  memberIds: active.peerId ? [String(active.peerId)] : [],
                })}
              >
                📞 Позвонить
              </button>
            </div>

            {err && <div className="error-text" style={{ padding: '0 12px' }}>{err}</div>}

            <div className="chat-feed" ref={feedRef}>
              {messages.length === 0 && <div className="muted" style={{ padding: 12 }}>Сообщений пока нет</div>}
              {messages.map((m, i) => {
                const mine = String(m.author_id) === String(user?.id);
                const newDay = i === 0 || dayOf(m.created_at) !== dayOf(messages[i - 1].created_at);
                return (
                  <div key={m.id}>
                    {newDay && <div className="chat-day">{dayOf(m.created_at)}</div>}
                    <div className={`chat-msg ${mine ? 'mine' : ''}`}>
                      {!mine && active.kind !== 'dm' && <div className="chat-author">{m.author_name}</div>}
                      {m.body && <div className="chat-body">{m.body}</div>}
                      {m.file_id && (
                        <a className="chat-file" href={`/api/files/${m.file_id}`} target="_blank" rel="noreferrer">
                          📎 {m.file_name}
                        </a>
                      )}
                      <div className="chat-time">{timeOf(m.created_at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="chat-input">
              <label className="btn btn-ghost btn-sm" title="Прикрепить файл" style={{ cursor: 'pointer' }}>
                📎
                <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.currentTarget.value = ''; }} />
              </label>
              <input
                className="input"
                placeholder="Сообщение…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
              <button className="btn btn-primary btn-sm" onClick={send} disabled={!draft.trim()}>➤</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ChatRow({ chat, active, onClick }: { chat: Chat; active: boolean; onClick: () => void }) {
  const icon = chat.kind === 'dm' ? (chat.title?.[0]?.toUpperCase() ?? '?') : '#';
  return (
    <button className={`chat-row ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="avatar-xs avatar-ph">{icon}</span>
      <span className="chat-row-main">
        <span className="chat-row-title">
          {chat.kind === 'dm' && <span className={`presence ${chat.peerOnline ? 'on' : ''}`} />}
          {chat.title ?? 'Чат'}
        </span>
        {chat.lastBody && (
          <span className="chat-row-last">
            {chat.kind !== 'dm' && chat.lastAuthor ? `${chat.lastAuthor}: ` : ''}{chat.lastBody}
          </span>
        )}
      </span>
      {chat.unread > 0 && <span className="chat-unread">{chat.unread}</span>}
    </button>
  );
}
