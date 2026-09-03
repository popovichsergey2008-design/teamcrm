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
import { GuestLinkButton } from '../components/GuestLinkButton';
import { GroupManageModal } from '../components/GroupManageModal';
import { ChatAttachment } from '../components/ChatAttachment';
import { Lightbox } from '../components/Lightbox';
import { humanSize, isAnonymousClipboardName, isImageName, screenshotName } from '../lib/attachments';
import type { User } from '../types';

interface Chat {
  id: string; kind: 'dm' | 'group' | 'project'; title: string | null;
  peerId: string | null; peerOnline: boolean; projectId: string | null; avatarUrl?: string | null;
  unread: number; lastBody: string | null; lastAuthor: string | null; lastAt: string | null;
}
interface Message {
  id: string; author_id: string | null; author_name: string | null; body: string;
  file_id: string | null; file_name: string | null; created_at: string;
  /** Ответ в ветке: в общей ленте таких нет, если автор не попросил обратного. */
  thread_root_id?: string | null;
  /** Сколько ответов в ветке этого сообщения. */
  reply_count?: number;
  last_reply_at?: string | null;
}

/** Строка раздела «Треды». */
interface ThreadItem {
  root_id: string; chat_id: string; chat_kind: string; chat_title: string | null;
  project_name: string | null; root_body: string; root_author: string | null;
  reply_count: number; last_reply_at: string | null; unread: number;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
/** «1 ответ», «2 ответа», «5 ответов» — иначе интерфейс выглядит машинным переводом. */
const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100;
  if (a > 10 && a < 20) return many;
  const b = a % 10;
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};
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
  /** Файл, выбранный или вставленный, но ещё не отправленный: его видно и можно подписать. */
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  /**
   * Открытая ветка: корневое сообщение и ответы.
   *
   * Панель справа от ленты, как в привычных рабочих чатах: разговор в ветке идёт,
   * не закрывая основной чат, — иначе теряется то, ради чего ветку и открыли.
   */
  const [thread, setThread] = useState<{ rootId: string; messages: Message[] } | null>(null);
  const [threadBody, setThreadBody] = useState('');
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  /** Раздел «Треды»: мои ветки вместо переписки. */
  const [threadsView, setThreadsView] = useState(false);
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
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
  const loadThreads = useCallback(
    () => api.myThreads().then(setThreads).catch(() => undefined),
    [],
  );

  const appendMessage = useCallback((m: Message) => {
    setMessages((prev) => (prev.some((x) => String(x.id) === String(m.id)) ? prev : [...prev, m]));
  }, []);

  useEffect(() => {
    reload();
    api.listUsers().then(setUsers).catch(() => undefined);
    void loadThreads(); // счётчик веток нужен сразу, а не после захода в раздел
  }, [reload, loadThreads]);

  // Новые сообщения приходят по тому же сокету, что и события досок.
  useEffect(() => {
    const socket = getSocket();
    const onMessage = (p: { chatId: string; message: Message }) => {
      if (String(p.chatId) === String(activeId)) {
        const rootId = p.message.thread_root_id ? String(p.message.thread_root_id) : null;
        // Ответ из ветки в общую ленту не попадает — ради этого треды и заводились.
        // Но счётчик «N ответов» на корневом сообщении обязан вырасти сразу.
        if (rootId) {
          setMessages((prev) => prev.map((m) => (String(m.id) === rootId
            ? { ...m, reply_count: (m.reply_count ?? 0) + 1, last_reply_at: p.message.created_at }
            : m)));
          setThread((prev) => (prev && prev.rootId === rootId
            ? { ...prev, messages: prev.messages.some((x) => String(x.id) === String(p.message.id))
              ? prev.messages : [...prev.messages, p.message] }
            : prev));
        } else {
          appendMessage(p.message);
        }
        api.markChatRead(p.chatId).catch(() => undefined);
      }
      reload();
      if (threadsView) void loadThreads();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, reload, appendMessage, threadsView]);

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

  /**
   * Скриншот из буфера — как в мессенджерах: Ctrl+V, и картинка в переписке.
   *
   * Слушаем всё окно, а не поле ввода: снимок делают, возвращаются в чат и жмут
   * Ctrl+V, не целясь курсором в строку сообщения. Вставку текста это не задевает —
   * реагируем, только если в буфере действительно файл-картинка.
   */
  useEffect(() => {
    if (!activeId) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      attach(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // сменили чат — недоотправленное вложение к новому собеседнику отношения не имеет
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => clearPending, [activeId]);

  // лента всегда прокручена вниз: читают последнее, а не начало переписки
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /**
   * Отправка.
   *
   * Одно действие на оба случая: есть вложение — уходит файл с подписью, нет —
   * обычное сообщение. Иначе человеку приходится помнить, какой кнопкой отправлять
   * картинку, а какой текст.
   */
  const send = async () => {
    const text = draft.trim();
    if (!activeId || (!text && !pending)) return;
    const file = pending?.file ?? null;
    setDraft('');
    clearPending();
    try {
      const message = file
        ? await api.sendChatFile(activeId, file, text)
        : await api.sendChatMessage(activeId, text);
      appendMessage(message);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : file ? 'Файл не отправлен' : 'Сообщение не отправлено');
      setDraft(text); // не теряем набранное
      if (file) attach(file); // и вложение возвращаем в очередь — переснимать экран обидно
    }
  };

  /**
   * Взять файл к отправке.
   *
   * Показываем его человеку и ждём — как в мессенджерах: скриншот вставляют, потом
   * подписывают, и только потом отправляют. Раньше файл улетал сразу по выбору, и
   * подписать его было нечем.
   *
   * Скриншот из буфера приходит без имени («image.png») — даём ему дату и время,
   * иначе в списке файлов копится десяток одинаковых.
   */
  const attach = (file: File) => {
    const named = isAnonymousClipboardName(file.name) && file.type.startsWith('image/')
      ? new File([file], screenshotName(new Date(), file.type), { type: file.type })
      : file;
    setPending((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file: named, url: isImageName(named.name) ? URL.createObjectURL(named) : '' };
    });
  };

  const clearPending = () => setPending((prev) => {
    if (prev?.url) URL.revokeObjectURL(prev.url);
    return null;
  });

  /** Открыть ветку сообщения: подгружаем целиком, сервер тем же запросом её и отмечает. */
  const openThread = async (rootId: string) => {
    if (!activeId) return;
    setThreadBody(''); setAlsoInChannel(false);
    try {
      const messages = await api.chatThread(activeId, rootId);
      setThread({ rootId: String(rootId), messages });
      notifyChatsChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть ветку'); }
  };

  const sendToThread = async () => {
    const text = threadBody.trim();
    if (!text || !thread || !activeId) return;
    setThreadBody('');
    try {
      await api.sendChatMessage(activeId, text, { rootId: thread.rootId, alsoInChannel });
      // своё сообщение придёт сокетом — второй раз его не добавляем
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ответ не отправлен');
      setThreadBody(text);
    }
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
  const threadsUnread = threads.reduce((sum, t) => sum + (Number(t.unread) || 0), 0);
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

        {/*
          «Треды» — первым пунктом списка, как в привычных рабочих чатах.
          Отвечают обычно в ветке, а ветку легко не заметить: она не поднимает чат
          наверх и не мигает счётчиком. Этот раздел и отвечает на вопрос «где меня ждут».
        */}
        <button
          className={`chat-row chat-row-threads${threadsView ? ' active' : ''}`}
          onClick={() => { setThreadsView((v) => !v); setThread(null); void loadThreads(); }}
        >
          <span className="chat-threads-icon" aria-hidden="true"><Icon name="chat" size={15} /></span>
          <span className="chat-row-main">
            <span className="chat-row-title">Треды</span>
            <span className="chat-row-last dim">ветки, где вы участвуете</span>
          </span>
          {threadsUnread > 0 && <span className="chat-unread">{threadsUnread}</span>}
        </button>

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
        {/*
          Созвон и внешняя ссылка — постоянно, а не только при открытом чате.
          Человек заходит в раздел, чтобы поговорить; заставлять его сначала выбрать
          собеседника в списке, чтобы появилась кнопка «Созвон», — лишний шаг ровно
          там, где нужна скорость.
        */}
        <div className="chat-view-head">
          <GuestLinkButton
            chats={[...dms, ...groups].map((c) => ({ id: String(c.id), title: c.title ?? 'Чат' }))}
            chatId={activeId ? String(activeId) : null}
            compact
          />
          <CallStarter
            chatId={active ? String(active.id) : null}
            kind={active?.kind}
            peerId={active?.peerId}
            disabled={!!inCall}
            onStart={({ memberIds, withAi: ai }) => onCall({
              id: active?.id ?? '',
              title: active?.title ?? 'Созвон',
              memberIds,
              projectId: active?.projectId,
              withAi: ai,
            })}
          />
        </div>

        {threadsView && (
          <div className="threads-view">
            <div className="chat-head"><span><Icon name="chat" size={15} /> <b>Мои ветки</b></span></div>
            {threads.length === 0 && (
              <EmptyState
                compact
                icon="chat"
                title="Веток пока нет"
                hint="Ветка — обсуждение одного сообщения. Нажмите «Ответить в ветке» под любым сообщением, и разговор пойдёт отдельно, не засоряя чат."
              />
            )}
            {threads.map((t) => (
              <button
                key={t.root_id}
                className="thread-item"
                onClick={() => { setThreadsView(false); void openChat(String(t.chat_id)).then(() => openThread(String(t.root_id))); }}
              >
                <span className="thread-item-head">
                  <b>{t.project_name ?? t.chat_title ?? 'Личный диалог'}</b>
                  {t.unread > 0 && <span className="chat-unread">{t.unread}</span>}
                </span>
                <span className="thread-item-body dim">{t.root_author}: {t.root_body.slice(0, 120)}</span>
                <span className="thread-item-foot dim">
                  {t.reply_count} {plural(t.reply_count, 'ответ', 'ответа', 'ответов')}
                  {t.last_reply_at ? ` · ${timeOf(t.last_reply_at)}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        {!active && !threadsView && (
          <div className="chat-empty">
            <EmptyState
              icon="chat"
              title="Выберите, кому написать"
              hint="Слева — личные диалоги и группы. Чтобы собрать несколько человек, нажмите «+» над списком. Из любого чата можно позвонить — с ИИ, который запишет разговор."
            />
          </div>
        )}
        {active && !threadsView && (
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
              {/* Кнопки созвона стоят в шапке раздела — одни на все чаты,
                  чтобы не повторять их в каждой переписке. */}
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
                        {/* Ссылкой файл открыть было нельзя: он за авторизацией и отдавал 401.
                            Картинка теперь видна сразу, остальное скачивается по нажатию. */}
                        {m.file_id && (
                          <ChatAttachment
                            fileId={m.file_id}
                            fileName={m.file_name ?? 'файл'}
                            onOpen={(url, name, mime) => setPreview({ url, name, mime })}
                          />
                        )}
                      </div>
                      <div className="chat-under">
                        <span className="chat-time">{timeOf(m.created_at)}</span>
                        {/*
                          Ветка сообщения. Кнопка видна всегда, а не по наведению: о том,
                          чего не видно, никто не догадается, а на касании наведения нет.
                          Строчка «N ответов» — вход в обсуждение, которое не засоряет ленту.
                        */}
                        {m.reply_count ? (
                          <button className="chat-thread-link" onClick={() => openThread(String(m.id))}>
                            <Icon name="chat" size={12} /> {m.reply_count} {plural(m.reply_count, 'ответ', 'ответа', 'ответов')}
                          </button>
                        ) : (
                          <button className="chat-thread-link chat-thread-new" onClick={() => openThread(String(m.id))}>
                            Ответить в ветке
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Вложение перед отправкой: видно, что именно уйдёт, и можно подписать.
                Отправлять вслепую — верный способ прислать не тот скриншот. */}
            {pending && (
              <div className="chat-pending">
                {pending.url
                  ? <img className="chat-pending-img" src={pending.url} alt={pending.file.name} />
                  : <Icon name="paperclip" size={16} />}
                <span className="chat-pending-name">
                  {pending.file.name} <span className="dim">· {humanSize(pending.file.size)}</span>
                </span>
                <button className="btn btn-ghost btn-sm" onClick={clearPending} title="Убрать вложение" aria-label="Убрать вложение">
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}

            <div
              className="chat-input"
              // Файл можно и перетащить — то же действие, что и вставка из буфера.
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); attach(f); } }}
            >
              <label className="btn btn-ghost btn-sm" title="Прикрепить файл" style={{ cursor: 'pointer' }}>
                <Icon name="paperclip" size={16} />
                <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.currentTarget.value = ''; }} />
              </label>
              <input
                className="input"
                placeholder={pending ? 'Подпись к вложению…' : 'Сообщение…'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={send}
                disabled={!draft.trim() && !pending}
                title="Отправить"
              >
                <Icon name="send" />
              </button>
            </div>
          </>
        )}
      </section>

      {/*
        Ветка — третьей колонкой, а не поверх переписки: обсуждение одного сообщения
        ведут, не теряя из виду сам чат. На узком экране колонка закрывает ленту,
        иначе обе становятся нечитаемыми.
      */}
      {thread && (
        <section className="chat-thread">
          <div className="chat-head">
            <span><Icon name="chat" size={15} /> <b>Ветка обсуждения</b></span>
            <button className="btn btn-ghost btn-sm" onClick={() => setThread(null)} title="Закрыть ветку" aria-label="Закрыть ветку">
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="chat-feed">
            {thread.messages.map((m, i) => (
              <div key={m.id} className={i === 0 ? 'thread-root' : ''}>
                <div className="chat-line">
                  <div className="chat-msg">
                    <div className="chat-author">{m.author_name}</div>
                    {m.body && <div className="chat-body">{m.body}</div>}
                    {m.file_id && (
                      <ChatAttachment
                        fileId={m.file_id}
                        fileName={m.file_name ?? 'файл'}
                        onOpen={(url, name, mime) => setPreview({ url, name, mime })}
                      />
                    )}
                  </div>
                  <div className="chat-time">{timeOf(m.created_at)}</div>
                </div>
                {i === 0 && thread.messages.length > 1 && (
                  <div className="thread-divider">
                    {thread.messages.length - 1} {plural(thread.messages.length - 1, 'ответ', 'ответа', 'ответов')}
                  </div>
                )}
              </div>
            ))}
          </div>
          {/* «Также отправить в основной чат»: иногда ответ важен не только участникам
              ветки — тогда он показывается и в общей ленте, оставаясь одним сообщением. */}
          <label className="thread-also">
            <input type="checkbox" checked={alsoInChannel} onChange={(e) => setAlsoInChannel(e.target.checked)} />
            Также отправить в основной чат
          </label>
          <div className="chat-input">
            <input
              className="input"
              placeholder="Ответить в ветке…"
              value={threadBody}
              onChange={(e) => setThreadBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToThread(); } }}
            />
            <button className="btn btn-primary btn-sm" onClick={sendToThread} disabled={!threadBody.trim()} title="Ответить">
              <Icon name="send" />
            </button>
          </div>
        </section>
      )}

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

      {/* Картинку смотрят целиком, не уходя из переписки. Блоб уже загружен лентой —
          повторно за ним не ходим, поэтому просмотр открывается мгновенно. */}
      {preview && (
        <Lightbox url={preview.url} name={preview.name} mime={preview.mime} onClose={() => setPreview(null)} />
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
