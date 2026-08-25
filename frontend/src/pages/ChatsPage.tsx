import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { getSocket } from '../lib/socket';
import { notificationPermission, notifyChatsChanged, requestNotificationPermission } from '../lib/notifications';
import { useAuth } from '../state/auth';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { GroupChatModal } from '../components/GroupChatModal';
import { CallStarter } from '../components/CallStarter';
import { GroupManageModal } from '../components/GroupManageModal';
import type { User } from '../types';

interface Chat {
  id: string; kind: 'dm' | 'group' | 'project'; title: string | null;
  peerId: string | null; peerOnline: boolean; projectId: string | null; avatarUrl?: string | null;
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
export function ChatsPage({ onCall, onActiveChat, initialChatId, inCall }: {
  onCall: (chat: { id: string; title: string; memberIds: string[]; projectId?: string | null; withAi?: boolean }) => void;
  /** Уже идёт созвон — второй начинать нельзя, кнопка гасится. */
  inCall?: boolean;
  /** Наверх — какой чат открыт: по нему уведомления не показываются. */
  onActiveChat?: (chatId: string | null) => void;
  /** Чат, который просили открыть снаружи — например кликом по уведомлению. */
  initialChatId?: string | null;
}) {
  // «Позвать ИИ» — решение на конкретный звонок, поэтому галочка живёт рядом с кнопкой,
  // а не в настройках: перед разговором видно, будет он записан или нет
  const { user } = useAuth();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [groupOpen, setGroupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [perm, setPerm] = useState(notificationPermission());
  const [err, setErr] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(
    () => api.listChats().then(setChats).catch(() => undefined).finally(() => setChatsLoaded(true)),
    [],
  );

  /**
   * Добавление в ленту с защитой от дубля. Своё сообщение прилетает дважды:
   * событием по сокету (сервер рассылает всем участникам, включая автора) и ответом REST,
   * причём событие обычно приходит РАНЬШЕ ответа. Сверяем по id.
   */
  const appendMessage = useCallback((m: Message) => {
    setMessages((prev) => (prev.some((x) => String(x.id) === String(m.id)) ? prev : [...prev, m]));
  }, []);

  useEffect(() => {
    reload();
    api.listUsers().then(setUsers).catch(() => undefined);
  }, [reload]);

  // Новые сообщения приходят по тому же сокету, что и события досок.
  useEffect(() => {
    const socket = getSocket();
    const onMessage = (p: { chatId: string; message: Message }) => {
      if (String(p.chatId) === String(activeId)) {
        appendMessage(p.message);
        api.markChatRead(p.chatId).catch(() => undefined);
      }
      reload();
    };
    const onDeleted = (p: { chatId: string; messageId: string }) => {
      if (String(p.chatId) === String(activeId)) setMessages((prev) => prev.filter((m) => m.id !== p.messageId));
    };
    // нас убрали из группы — чат должен исчезнуть, а не висеть открытым с ошибками
    const onRemoved = (p: { chatId: string }) => {
      if (String(p.chatId) === String(activeId)) { setActiveId(null); setMessages([]); }
      reload();
    };
    socket.on('chat.message', onMessage);
    socket.on('chat.message_deleted', onDeleted);
    socket.on('chat.created', reload);
    socket.on('chat.removed', onRemoved);
    return () => {
      socket.off('chat.message', onMessage);
      socket.off('chat.message_deleted', onDeleted);
      socket.off('chat.created', reload);
      socket.off('chat.removed', onRemoved);
    };
  }, [activeId, reload, appendMessage]);

  const openChat = useCallback(async (id: string) => {
    setActiveId(id); setErr(''); setMessages([]); setMsgLoading(true);
    try {
      setMessages(await api.chatMessages(id)); // чтение помечается на сервере этим же запросом
      reload();
      notifyChatsChanged(); // счётчик в шапке должен упасть сразу
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть чат'); }
    finally { setMsgLoading(false); }
  }, [reload]);

  // пришли из уведомления — открываем названный чат, а не последний
  useEffect(() => {
    if (initialChatId) openChat(String(initialChatId));
  }, [initialChatId, openChat]);

  useEffect(() => {
    onActiveChat?.(activeId);
    return () => onActiveChat?.(null); // ушли из раздела — уведомления снова нужны
  }, [activeId, onActiveChat]);

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
      appendMessage(message);
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
      appendMessage(message);
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
  // подразделения по id сотрудника — подписываем ими собеседников в списке и шапке
  const groupOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) {
      const names = (u.groups ?? []).map((g) => g.name);
      if (names.length) m.set(String(u.id), names.join(', '));
    }
    return m;
  }, [users]);
  const groupFor = (userId?: string | null) => (userId ? groupOf.get(String(userId)) : undefined);
  const listEmpty =
    dms.filter((c) => match(c.title)).length === 0 &&
    groups.filter((c) => match(c.title)).length === 0 &&
    others.filter((u) => match(u.fullName)).length === 0;

  return (
    <div className="chats">
      <aside className="chat-list">
        <div className="chat-list-head">
          <input className="input chat-search" placeholder="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn btn-ghost btn-sm" title="Создать группу" onClick={() => setGroupOpen(true)}><Icon name="plus" /></button>
        </div>

        {/* Разрешение спрашиваем по кнопке: непрошеный запрос браузеры глушат,
            и человек больше не сможет его выдать. */}
        {perm === 'default' && (
          <button className="btn btn-ghost btn-sm chat-notify-ask"
                  onClick={async () => setPerm(await requestNotificationPermission())}>
            <Icon name="bell" size={15} /> Включить уведомления
          </button>
        )}
        {perm === 'denied' && (
          <div className="dim chat-notify-hint">
            Уведомления запрещены в браузере. Непрочитанное всё равно видно в шапке и в заголовке вкладки.
          </div>
        )}

        {dms.filter((c) => match(c.title)).map((c) => (
          <ChatRow key={c.id} chat={c} active={String(c.id) === String(activeId)} group={groupFor(c.peerId)} onClick={() => openChat(c.id)} />
        ))}

        {groups.filter((c) => match(c.title)).length > 0 && <div className="chat-group-head">Группы и проекты</div>}
        {groups.filter((c) => match(c.title)).map((c) => (
          <ChatRow key={c.id} chat={c} active={String(c.id) === String(activeId)} onClick={() => openChat(c.id)} />
        ))}

        {others.filter((u) => match(u.fullName)).length > 0 && <div className="chat-group-head">Написать впервые</div>}
        {others.filter((u) => match(u.fullName)).map((u) => (
          <button key={u.id} className="chat-row" onClick={() => writeTo(u.id)}>
            <Avatar path={u.avatarUrl ?? null} fallback={u.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
            <span className="chat-row-main">
              <span className="chat-row-title">
                {u.fullName}
                {groupFor(u.id) && <span className="chat-row-group">{groupFor(u.id)}</span>}
              </span>
            </span>
          </button>
        ))}

        {!chatsLoaded && <div style={{ padding: '4px 8px' }}><SkeletonList rows={5} /></div>}
        {chatsLoaded && listEmpty && (
          query.trim() ? (
            <EmptyState compact icon="search" title="Ничего не нашлось" hint={`По запросу «${query.trim()}» нет ни чатов, ни коллег.`} />
          ) : (
            <EmptyState
              compact
              icon="users"
              title="Писать пока некому"
              hint="В организации нет других сотрудников. Пригласите команду в разделе «Команда» — и они появятся здесь."
            />
          )
        )}
      </aside>

      <section className="chat-view">
        {!active && (
          <div className="chat-empty">
            <EmptyState
              icon="chat"
              title="Выберите, кому написать"
              hint="Слева — личные диалоги и группы. Чтобы собрать несколько человек, нажмите «+» над списком. Из любого чата можно позвонить — с ИИ, который запишет разговор."
            />
          </div>
        )}
        {active && (
          <>
            <div className="chat-head">
              <span>
                {active.kind === 'dm' && <span className={`presence ${active.peerOnline ? 'on' : ''}`} title={active.peerOnline ? 'в сети' : 'не в сети'} />}
                <b>{active.title ?? 'Чат'}</b>
                {active.kind === 'dm' && groupFor(active.peerId) && (
                  <span className="chat-row-group">{groupFor(active.peerId)}</span>
                )}
                {active.kind === 'project' && <span className="badge badge-muted" style={{ marginLeft: 6 }}>проект</span>}
                {active.kind === 'group' && (
                  <button className="btn btn-ghost btn-sm" title="Участники и настройки группы"
                          onClick={() => setManageOpen(true)}><Icon name="settings" /></button>
                )}
              </span>
              <span className="chat-call">
                <CallStarter
                  chatId={String(active.id)}
                  kind={active.kind}
                  peerId={active.peerId}
                  disabled={!!inCall}
                  onStart={({ memberIds, withAi: ai }) => onCall({
                    id: active.id,
                    title: active.title ?? 'Чат',
                    memberIds,
                    projectId: active.projectId,
                    withAi: ai,
                  })}
                />
              </span>
            </div>

            {err && <div className="error-text" style={{ padding: '0 12px' }}>{err}</div>}

            <div className="chat-feed" ref={feedRef}>
              {msgLoading && <div style={{ padding: 12 }}><SkeletonList rows={4} /></div>}
              {!msgLoading && messages.length === 0 && (
                <EmptyState
                  compact
                  icon="send"
                  title="Здесь пока пусто"
                  hint={active.kind === 'dm'
                    ? 'Напишите первым — собеседник получит уведомление.'
                    : 'Начните обсуждение: сообщение увидят все участники группы.'}
                />
              )}
              {messages.map((m, i) => {
                const mine = String(m.author_id) === String(user?.id);
                const newDay = i === 0 || dayOf(m.created_at) !== dayOf(messages[i - 1].created_at);
                // системная строка (кого добавили, кто вышел) — без автора и без «пузыря»
                if (!m.author_id) {
                  return (
                    <div key={m.id}>
                      {newDay && <div className="chat-day">{dayOf(m.created_at)}</div>}
                      <div className="chat-system">{m.body}</div>
                    </div>
                  );
                }
                return (
                  <div key={m.id}>
                    {newDay && <div className="chat-day">{dayOf(m.created_at)}</div>}
                    {/* Время — ПОД плашкой, а не внутри неё: серая строчка на цветном
                        пузыре не читалась вовсе, а место в углу отъедала. */}
                    <div className={`chat-line ${mine ? 'mine' : ''}`}>
                      <div className={`chat-msg ${mine ? 'mine' : ''}`}>
                        {!mine && active.kind !== 'dm' && <div className="chat-author">{m.author_name}</div>}
                        {m.body && <div className="chat-body">{m.body}</div>}
                        {m.file_id && (
                          <a className="chat-file" href={`/api/files/${m.file_id}`} target="_blank" rel="noreferrer">
                            <Icon name="paperclip" size={14} /> {m.file_name}
                          </a>
                        )}
                      </div>
                      <div className="chat-time">{timeOf(m.created_at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="chat-input">
              <label className="btn btn-ghost btn-sm" title="Прикрепить файл" style={{ cursor: 'pointer' }}>
                <Icon name="paperclip" size={16} />
                <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.currentTarget.value = ''; }} />
              </label>
              <input
                className="input"
                placeholder="Сообщение…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
              <button className="btn btn-primary btn-sm" onClick={send} disabled={!draft.trim()} title="Отправить"><Icon name="send" /></button>
            </div>
          </>
        )}
      </section>

      {manageOpen && active && (
        <GroupManageModal
          chatId={active.id}
          title={active.title ?? ''}
          users={users}
          meId={user?.id}
          onClose={() => setManageOpen(false)}
          onChanged={reload}
          onLeft={() => {
            // вышли — чат больше не наш: закрываем окно и очищаем ленту
            setManageOpen(false);
            setActiveId(null);
            setMessages([]);
            reload();
          }}
        />
      )}

      {groupOpen && (
        <GroupChatModal
          users={users}
          meId={user?.id}
          onClose={() => setGroupOpen(false)}
          onCreated={async (chatId) => {
            setGroupOpen(false);
            await reload();
            openChat(chatId); // сразу открываем созданную группу — иначе её надо искать в списке
          }}
        />
      )}
    </div>
  );
}

function ChatRow({ chat, active, group, onClick }: { chat: Chat; active: boolean; group?: string; onClick: () => void }) {
  const icon = chat.kind === 'dm' ? (chat.title?.[0]?.toUpperCase() ?? '?') : '#';
  return (
    <button className={`chat-row ${active ? 'active' : ''}`} onClick={onClick}>
      {/* у личного диалога — лицо собеседника: по десятку одинаковых кружков с буквой
          чат не находится взглядом, а по фотографии находится сразу */}
      <Avatar path={chat.avatarUrl ?? null} fallback={icon} className="avatar-sm" />
      <span className="chat-row-main">
        <span className="chat-row-title">
          {chat.kind === 'dm' && <span className={`presence ${chat.peerOnline ? 'on' : ''}`} />}
          {chat.title ?? 'Чат'}
          {/* подразделение собеседника: когда в компании полсотни человек, одно имя мало что говорит */}
          {group && <span className="chat-row-group" title={`Подразделение: ${group}`}>{group}</span>}
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
