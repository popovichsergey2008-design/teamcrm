import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { api, ApiError, Scheduled } from '../lib/api';
import { getSocket } from '../lib/socket';
import { navigate } from '../lib/router';
import { useClipRecorder } from '../hooks/useClipRecorder';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { notificationPermission, notifyChatsChanged, requestNotificationPermission } from '../lib/notifications';
import { useAuth } from '../state/auth';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { GroupChatModal } from '../components/GroupChatModal';
import { CallStarter } from '../components/CallStarter';
import { GuestLinkButton } from '../components/GuestLinkButton';
import { ChatInfoPanel } from '../components/chat/ChatInfoPanel';
import { AnthillPanel } from '../components/anthill/AnthillPanel';
import { ChatAttachment } from '../components/ChatAttachment';
import { Lightbox } from '../components/Lightbox';
import { humanSize, isAnonymousClipboardName, isImageName, screenshotName } from '../lib/attachments';
import { remindLabel, remindOptions } from '../lib/remind-times';
import { MentionField } from '../components/MentionField';
import { MessageText } from '../components/MessageText';
import { longPressProps, MenuAt, MessageMenu } from '../components/MessageMenu';
import { useDismiss } from '../hooks/useDismiss';
import { selectionIn } from '../lib/selection';
import { shrinkAll } from '../lib/image-shrink';
import { MessageToTask } from '../components/MessageToTask';
import { ChannelModal } from '../components/ChannelModal';
import { stillMentioned } from '../lib/mentions';
import { plural, stampLabel } from '../lib/chat-text';
import { applyOrder, moveItem } from '../lib/menu-order';
import { firstUnreadId } from '../lib/unread-line';
import { showToast, toastSaved } from '../lib/notifications';
import { overlayProps } from '../lib/overlay';
import type { User } from '../types';

interface Chat {
  id: string; kind: 'dm' | 'group' | 'project' | 'channel' | 'self' | 'external'; title: string | null;
  peerId: string | null; peerOnline: boolean; projectId: string | null; avatarUrl?: string | null;
  unread: number; lastBody: string | null; lastAuthor: string | null; lastAt: string | null;
  /** Закреплён сверху лично этим человеком. */
  favorite?: boolean;
  /** Помечен непрочитанным вручную — как в Telegram; снимается открытием чата. */
  markedUnread?: boolean;
  isPrivate?: boolean;
  description?: string | null;
  /** В разговоре есть человек со стороны: всё сказанное здесь он увидит. */
  isExternal?: boolean;
}
interface Message {
  id: string; author_id: string | null; author_name: string | null; body: string;
  file_id: string | null; file_name: string | null; created_at: string;
  /** Ответ в ветке: в общей ленте таких нет, если автор не попросил обратного. */
  thread_root_id?: string | null;
  /** Ответ в ленте: на что отвечали, чьими словами и что процитировано. */
  reply_to_id?: string | null;
  reply_body?: string | null;
  reply_author?: string | null;
  /** Сколько ответов в ветке этого сообщения. */
  reply_count?: number;
  last_reply_at?: string | null;
  /** Сводка реакций, а не список нажавших: в ленте нужен знак и число. */
  reactions?: { emoji: string; count: number; mine: boolean }[];
  pinned_at?: string | null;
  /** Итог созвона: сообщение разворачивается в карточку со сводкой и разбором. */
  meeting_id?: string | null;
  /** Ответ помощника: помечен, чтобы его не спутали со словами коллеги. */
  is_ai?: boolean;
  /** Имя внешнего собеседника: учётной записи у него нет. */
  guest_name?: string | null;
  /** Задача, заведённая по этому сообщению: чтобы вторую по той же фразе не завели. */
  task_id?: string | null;
  task_title?: string | null;
  /** Проект задачи: адрес задачи без него не собрать — ссылка уводила в список проектов. */
  task_project_id?: string | null;
  /** Все вложения сообщения: несколько картинок — это одно сообщение. */
  files?: { fileId: string; name: string; mime?: string; size?: number }[];
  /** Сколько собеседников прочитали сообщение и сколько их всего — для галочек. */
  read_by?: number;
  others?: number;
  edited_at?: string | null;
}

/** Строка раздела «Треды». */
interface ThreadItem {
  root_id: string; chat_id: string; chat_kind: string; chat_title: string | null;
  project_name: string | null; root_body: string; root_author: string | null;
  reply_count: number; last_reply_at: string | null; unread: number;
}

/**
 * Разделы над списком чатов.
 *
 * Без них человек обходит тридцать переписок, чтобы понять, где его ждут: ветка не
 * поднимает чат наверх, упоминание ничем не отличается от обычного сообщения, а
 * сохранённое вообще негде смотреть.
 */
const SECTIONS: { key: 'inbox' | 'threads' | 'saved'; title: string; hint: string; icon: 'inbox' | 'chat' | 'star' }[] = [
  { key: 'inbox', title: 'Входящие', hint: 'всё, что ждёт лично вас', icon: 'inbox' },
  { key: 'threads', title: 'Треды', hint: 'ветки, где вы участвуете', icon: 'chat' },
  { key: 'saved', title: 'Сохранённое', hint: 'важное под рукой', icon: 'star' },
];

/** Реакции: ответить «понял», не засоряя переписку и не будя всех уведомлением. */
const REACTIONS = ['👍', '❤️', '🔥', '👏', '😁', '🤔'];

/** «@AI», «@ии», «@ai-помощник» — человек пишет как придётся. */
const MENTIONS_AI = /@(anthillbot|ai|ии|ai-помощник|бот)(?![\wа-яё-])/gi;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });

/**
 * Когда уйдёт отложенное.
 *
 * У ежедневного это не дата, а правило: «каждый день в 09:00». Показывать ему
 * конкретное число неправильно — человек подумает, что оно уйдёт один раз.
 */
const laterLabel = (x: { sendAt: string; repeat: 'none' | 'daily' }) => {
  const at = new Date(x.sendAt);
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return x.repeat === 'daily' ? `каждый день в ${time}` : remindLabel(at);
};

/**
 * Мессенджер: слева люди и группы, справа переписка. Звонок — из шапки чата,
 * то есть звонишь конкретному человеку, а не в общую комнату.
 */
export function ChatsPage({ onCall, onActiveChat, initialChatId, inCall, mode = 'page', onClose, context }: {
  onCall: (chat: { id: string; title: string; memberIds: string[]; projectId?: string | null; withAi?: boolean }) => void;
  /** Уже идёт созвон — второй начинать нельзя, кнопка гасится. */
  inCall?: boolean;
  /** Наверх — какой чат открыт: по нему уведомления не показываются. */
  onActiveChat?: (chatId: string | null) => void;
  /** Чат, который просили открыть снаружи — например кликом по уведомлению. */
  initialChatId?: string | null;
  /**
   * `overlay` — окно чата поверх CRM (ТЗ-5): одна переписка без списка и разделов,
   * ветка раскрывается поверх ленты. Вся механика — та же, что в разделе: это тот
   * же компонент, а не копия, и правки в одном месте доезжают в оба.
   */
  mode?: 'page' | 'overlay';
  /** Крестик в окне поверх CRM. */
  onClose?: () => void;
  /** Что под окном: задача или проект — «+ Отправить в чат» одной кнопкой (ТЗ-5, раздел 30). */
  context?: { taskId?: string; projectId?: string };
}) {
  const overlay = mode === 'overlay';
  // «Позвать ИИ» — решение на конкретный звонок, поэтому галочка живёт рядом с кнопкой,
  // а не в настройках: перед разговором видно, будет он записан или нет
  const { user } = useAuth();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);
  /**
   * Подгрузка ленты вверх (ТЗ-5, раздел 46): открывается хвост в 50 сообщений,
   * остальное подтягивается, когда человек докрутил до верха. Тысяча сообщений
   * разом — это и секунды ожидания, и тысяча узлов в DOM ради одного взгляда.
   */
  const [hasOlder, setHasOlder] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  /** Пока подшиваем старое сверху, прокрутку вниз не трогаем — иначе прыжок к концу. */
  const keepScroll = useRef(false);
  /**
   * Секции списка чатов: порядок и свёрнутые — личные, на сервере (ТЗ-5, раздел 38).
   * Ключи фиксированы: по ним же строится порядок, чужие ключи игнорируются.
   */
  const [sectionPrefs, setSectionPrefs] = useState<{ order: string[]; collapsed: string[] }>(() => ({
    order: user?.uiPrefs?.chatSections?.order ?? [],
    collapsed: user?.uiPrefs?.chatSections?.collapsed ?? [],
  }));
  const saveSections = (next: { order: string[]; collapsed: string[] }) => {
    setSectionPrefs(next);
    void api.saveUiPrefs({ chatSections: next }).catch(() => undefined);
  };
  const [dragSection, setDragSection] = useState<string | null>(null);
  /**
   * Черта «Непрочитанные сообщения»: id первого нового.
   *
   * Считается из цифры в списке чатов ДО открытия — сервер к этому моменту уже
   * всё пометил прочитанным. Список берём через ссылку: openChat — useCallback,
   * и в его замыкании лежал бы список на момент создания функции.
   */
  const [unreadFrom, setUnreadFrom] = useState<string | null>(null);
  /**
   * Виден ли раздел прямо сейчас.
   *
   * Разделы не размонтируются при уходе (App держит их живыми ради состояния и
   * прокрутки), поэтому «чат открыт» и «человек его видит» — разные вещи. Из-за
   * этого новые сообщения в последнем открытом чате помечались прочитанными, пока
   * человек работал в задачах: кружочек непрочитанного не появлялся вовсе.
   *
   * У скрытого через `display: none` узла нет offsetParent — это и есть проверка.
   */
  const onScreen = () => !!feedRef.current?.offsetParent;
  const chatsRef = useRef<Chat[]>([]);
  useEffect(() => { chatsRef.current = chats; }, [chats]);
  const [users, setUsers] = useState<User[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  /** Где в ленте стоит черта: всё чужое от неё и ниже подсвечивается как новое. */
  const unreadIndex = useMemo(
    () => (unreadFrom ? messages.findIndex((m) => String(m.id) === unreadFrom) : -1),
    [messages, unreadFrom],
  );
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  /**
   * Поиск по ПЕРЕПИСКЕ, а не только по названиям чатов.
   *
   * Заказчик: «нужен поиск во всех чатах, как в телеграме». То же поле: человек
   * набирает слово и получает и чаты с таким названием, и сами сообщения.
   */
  const [found, setFound] = useState<{
    messageId: string; chatId: string; chatTitle: string; chatKind: string;
    authorName: string | null; body: string; createdAt: string; threadRootId: string | null;
  }[]>([]);
  const [searching, setSearching] = useState(false);
  /**
   * Отложенные сообщения: написать сейчас, отправить потом.
   *
   * `laterOpen` — открыт выбор времени, `scheduled` — что уже отложено в этом чате.
   */
  const [laterOpen, setLaterOpen] = useState(false);
  /** Открыто окно «Отложенные сообщения» — со списком и действиями над каждым. */
  const [queueOpen, setQueueOpen] = useState(false);
  /** Как откладываем: один раз в дату и время или каждый день в это время. */
  const [laterRepeat, setLaterRepeat] = useState<'none' | 'daily'>('none');
  const [laterAt, setLaterAt] = useState('');
  const [laterTime, setLaterTime] = useState('09:00');
  /**
   * Вложения, приготовленные для ответа в ветке.
   *
   * Своя очередь, как у основного поля: вставленные подряд снимки должны уйти
   * ОДНИМ сообщением. Раньше каждая вставка отправлялась сразу, и три картинки
   * превращались в три сообщения — ровно то, на что жаловался заказчик.
   */
  const [threadPending, setThreadPending] = useState<{ file: File; url: string }[]>([]);

  /** Поиск внутри открытого чата: лупа в шапке, как в мессенджерах. */
  const [inChatSearch, setInChatSearch] = useState(false);
  const [inChatQuery, setInChatQuery] = useState('');
  /**
   * Что нашлось в этом разговоре.
   *
   * Ищем по УЖЕ загруженной ленте, без похода на сервер: в открытом чате человек
   * ищет то, что видел недавно, а за старым есть общий поиск слева. Заодно поиск
   * работает мгновенно и без сети.
   */
  const inChatHits = useMemo(() => {
    const q = inChatQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return messages.filter((m) => String(m.body ?? '').toLowerCase().includes(q));
  }, [inChatQuery, messages]);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [groupOpen, setGroupOpen] = useState(false);
  const [perm, setPerm] = useState(notificationPermission());
  const [err, setErr] = useState('');
  /** Файл, выбранный или вставленный, но ещё не отправленный: его видно и можно подписать. */
  /**
   * Что приложено к следующему сообщению — СПИСОК, а не один файл.
   *
   * В мессенджерах несколько снимков уходят одним сообщением; у нас каждая вставка
   * вытесняла предыдущую, и человек мог приложить ровно одну картинку.
   */
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  /**
   * Открытая ветка: корневое сообщение и ответы.
   *
   * Панель справа от ленты, как в привычных рабочих чатах: разговор в ветке идёт,
   * не закрывая основной чат, — иначе теряется то, ради чего ветку и открыли.
   */
  const [thread, setThread] = useState<{ rootId: string; messages: Message[] } | null>(null);
  /**
   * Ответ на сообщение В ЛЕНТЕ — как в Telegram.
   *
   * Живёт рядом с ветками и не заменяет их: ответ остаётся в общем разговоре и
   * цитирует одну реплику, ветка уводит обсуждение в сторону. Заказчик просил оба
   * и особо оговорил, что они должны уживаться.
   */
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; excerpt: string } | null>(null);
  /**
   * Сайдбар чата ⓘ (ТЗ-5, этап 2). Занимает тот же правый слот, что и ветка:
   * два столбца справа не поместятся, и открытие одного закрывает другой.
   */
  const [infoOpen, setInfoOpen] = useState(false);
  /** В окне поверх CRM второстепенные кнопки композера спрятаны за «+». */
  const [extraOpen, setExtraOpen] = useState(false);
  /** Открытая ветка для обработчиков сокета: они живут дольше одного отрисованного кадра. */
  const threadRef = useRef<{ rootId: string; messages: Message[] } | null>(null);
  useEffect(() => { threadRef.current = thread; }, [thread]);
  const [threadBody, setThreadBody] = useState('');
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  /** Закреплённое чата: то, что нужно всем и всегда под рукой. */
  const [pinned, setPinned] = useState<Message[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  /** Куда прокрутили из закреплённого — подсвечиваем, иначе непонятно, что нашли. */
  const [highlight, setHighlight] = useState<string | null>(null);
  /**
   * Меню сообщения по правой кнопке — как в Telegram.
   *
   * Просьба заказчика: «убрать эти троеточия везде и сделать один в один как в
   * телеграме». Одно меню на страницу: у какого сообщения открыто и в какой точке.
   */
  const [ctxFor, setCtxFor] = useState<{ id: string; at: MenuAt; picked: string } | null>(null);
  /** Какой раздел открыт вместо переписки: входящие, треды, сохранённое. */
  const [view, setView] = useState<'chat' | 'inbox' | 'threads' | 'saved' | 'channels' | 'anthill'>('chat');
  /**
   * «Входящие» — только личное: упоминания, личные сообщения, ответы на мои реплики
   * и ветки, где я участвую. Обычные сообщения общих чатов сюда не попадают.
   */
  const [inbox, setInbox] = useState<{
    mentions: any[]; threads: any[]; dms: any[]; replies: any[];
    counts: { mentions: number; threads: number; dms: number; replies: number };
  } | null>(null);
  const [saved, setSaved] = useState<any[]>([]);
  /** Какие из показанных сообщений уже сохранены — чтобы кнопка знала своё состояние. */
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  /** У какого сообщения открыт выбор времени напоминания. */
  const [remindFor, setRemindFor] = useState<string | null>(null);
  /** Кого позвали по «@»: id, а не имена — имена переименовываются. */
  const [mentioned, setMentioned] = useState<string[]>([]);
  /** Клип ушёл на сервер: там его ещё расшифровывают, и это занимает секунды. */
  const [clipBusy, setClipBusy] = useState(false);
  /** Витрина «Все каналы»: публичные каналы компании. */
  const [channelList, setChannelList] = useState<{
    id: string; title: string | null; description: string | null;
    members: number; joined: boolean; last_message_at: string | null;
  }[]>([]);
  const [channelOpen, setChannelOpen] = useState(false);
  /** Сводка непрочитанного и ответ поиска — показываются панелью, в чат не пишутся. */
  const [digest, setDigest] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  /**
   * Вопрос помощнику голосом (ТЗ-5, раздел 29): записал — расшифровали — спросили —
   * ответ в ленту. Расшифровка та же, что у голосовой постановки задач; ответ идёт
   * тем же путём, что и «@AI» текстом, — второй дороги для помощника нет.
   */
  /** Кто сейчас печатает в открытом чате: имя и до какого момента верить. */
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  useEffect(() => {
    if (!Object.keys(typing).length) return;
    const t = window.setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        const next = Object.fromEntries(Object.entries(prev).filter(([, v]) => v.until > now));
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [typing]);
  useEffect(() => { setTyping({}); }, [activeId]);
  /** Своё «печатаю» — не чаще раза в две секунды, пока набирают. */
  const typingSentAt = useRef(0);
  const noteTyping = () => {
    if (!activeId) return;
    const now = Date.now();
    if (now - typingSentAt.current < 2000) return;
    typingSentAt.current = now;
    getSocket().emit('chat.typing', { chatId: activeId });
  };
  const typingNames = Object.values(typing).map((t) => t.name);

  const aiVoice = useVoiceInput(async (text) => {
    const q = text.trim();
    if (!activeId || !q) return;
    setAiBusy(true);
    try { await api.askChatAi(activeId, q); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Помощник не ответил'); }
    finally { setAiBusy(false); }
  });
  const [aiQuery, setAiQuery] = useState('');
  const [aiAnswer, setAiAnswer] = useState<{
    answer: string;
    refs: { messageId: string; chatId: string; chat: string; author: string | null; at: string; text: string }[];
  } | null>(null);
  /** Из какого сообщения делаем задачу: окно с черновиком от ИИ. */
  const [toTask, setToTask] = useState<Message | null>(null);
  /** Какое сообщение сейчас правим и что в поле правки. */
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  /**
   * Прокрутили ленту — меню осталось бы висеть над чужой репликой: закрываем.
   *
   * Само место меню считает MessageMenu: оно ложится координатами курсора и
   * раскрывается вверх, когда снизу не помещается. Раньше место считала страница,
   * привязываясь к кнопке «ещё», — кнопки больше нет.
   */
  const closePops = () => setCtxFor(null);
  /*
    Всплывашки закрываются щелчком мимо и Esc — общим правилом (useDismiss).

    Жалоба заказчика: «невозможно закрыть эти выпадашки без перезагрузки». Кнопку,
    которая окно открыла, из правила исключаем: она переключает своё состояние сама,
    иначе повторное нажатие закрывало бы и тут же открывало окно заново.
  */
  const closePins = useCallback(() => setPinsOpen(false), []);
  useDismiss(pinsOpen, closePins, '.chat-pins-btn');
  const closeLater = useCallback(() => setLaterOpen(false), []);
  useDismiss(laterOpen, closeLater, '.chat-later-btn');

  /** Что за сущность стоит за чатом — показывается в шапке. */
  const [ctx, setCtx] = useState<{
    project_id: string | null; project_name: string | null; status: string | null;
    open_tasks: number; overdue: number; client_name: string | null;
    nearest_deadline?: string | null; owner_name?: string | null; owner_id?: string | null;
  } | null>(null);
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
  /**
   * Голосовое сообщение и запись экрана.
   *
   * Отправляются сразу по окончании записи: показывать превью аудио бессмысленно —
   * прослушать себя перед отправкой всё равно никто не станет, а лишний шаг убивает
   * весь смысл «быстрее, чем печатать».
   */
  const clip = useClipRecorder(async (blob, kind) => {
    if (!activeId) return;
    setClipBusy(true);
    try { await api.sendChatClip(activeId, blob, kind); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Запись не отправлена'); }
    finally { setClipBusy(false); }
  });

  /** Закрепить чат сверху или снять: порядок личный, у каждого свои четыре. */
  const star = async (c: Chat) => {
    setChats((prev) => prev.map((x) => (String(x.id) === String(c.id) ? { ...x, favorite: !x.favorite } : x)));
    try { await api.toggleChatFavorite(String(c.id)); reload(); }
    catch { reload(); }
  };

  /**
   * «Пометить как непрочитанное» — с этого сообщения, как просил заказчик.
   *
   * Оно и всё после него снова новые. Открытый чат закрываем: он «читается» самим
   * фактом открытия — следующее сообщение или возврат во вкладку сняли бы пометку,
   * не успев её показать.
   */
  const markUnreadFrom = async (m: Message) => {
    if (!activeId) return;
    const chatId = activeId;
    setActiveId(null); setMessages([]); setThread(null);
    try { await api.markUnreadFromMessage(chatId, String(m.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось пометить'); }
    finally { reload(); notifyChatsChanged(); }
  };

  /** Чат с собой: открывается один и тот же, сколько ни нажимай. */
  const openNotes = async () => {
    try {
      const chat = await api.openSelfChat();
      await reload();
      openChat(String(chat.id));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть заметки'); }
  };

  const loadChannels = useCallback(() => {
    api.listChannels().then(setChannelList).catch(() => undefined);
  }, []);

  const join = async (chatId: string) => {
    try {
      await api.joinChannel(chatId);
      await reload();
      setView('chat');
      openChat(String(chatId));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось вступить'); }
  };

  /*
    Всплывающие набор реакций и меню закрываются кликом мимо.

    Без этого они висят открытыми, пока не нажмёшь ту же кнопку, — и человек, кликнув
    по другому сообщению, получает два открытых меню сразу.
  */

  const loadInbox = useCallback(() => { api.chatInbox().then(setInbox).catch(() => undefined); }, []);
  const loadSaved = useCallback(() => {
    api.listSavedMessages().then((rows) => {
      setSaved(rows);
      setSavedIds(new Set(rows.map((r: any) => String(r.id))));
    }).catch(() => undefined);
  }, []);

  const loadPinned = useCallback((chatId: string) => {
    api.chatPinned(chatId).then(setPinned).catch(() => undefined);
  }, []);

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
    loadInbox();
    loadSaved();
  }, [reload, loadThreads, loadInbox, loadSaved]);

  // Новые сообщения приходят по тому же сокету, что и события досок.
  useEffect(() => {
    const socket = getSocket();
    const onMessage = (p: { chatId: string; message: Message }) => {
      if (String(p.chatId) === String(activeId)) {
        const rootId = p.message.thread_root_id ? String(p.message.thread_root_id) : null;
        // Ответ из ветки в общую ленту не попадает — ради этого треды и заводились.
        // Но счётчик «N ответов» на корневом сообщении обязан вырасти сразу.
        if (rootId) {
          // Своё сообщение уже посчитано при отправке — по длине ветки, а не
          // прибавлением. Прибавить ещё раз значит показать «2 ответа» там, где один.
          const mine = String(p.message.author_id) === String(user?.id);
          if (!mine) {
            setMessages((prev) => prev.map((m) => (String(m.id) === rootId
              ? { ...m, reply_count: (m.reply_count ?? 0) + 1, last_reply_at: p.message.created_at }
              : m)));
          }
          setThread((prev) => (prev && prev.rootId === rootId
            ? { ...prev, messages: prev.messages.some((x) => String(x.id) === String(p.message.id))
              ? prev.messages : [...prev.messages, p.message] }
            : prev));
        } else {
          appendMessage(p.message);
        }
        /*
          Открытый чат = прочитано, но ТОЛЬКО когда вкладка на виду.

          Отметку ждём и лишь потом перечитываем список: раньше `reload()` уходил
          одновременно с отметкой и возвращал старый счётчик — единица висела на
          чате, пока по нему не щёлкнешь ещё раз. Ровно на это и жаловались.
        */
        if (!document.hidden && onScreen()) {
          api.markChatRead(p.chatId)
            .then(() => { reload(); notifyChatsChanged(); })
            .catch(() => reload());
          if (p.message?.thread_root_id || view === 'threads') void loadThreads();
          return;
        }
      }
      reload();
      /*
        Ветки пересчитываем ВСЕГДА, а не только на открытом разделе «Треды».

        Заказчик: «треды не появляются сразу после отправки сообщения и требуют
        перезагрузки». Ветка рождается первым ответом, и её счётчик висит в меню —
        значит, знать о ней надо независимо от того, какой раздел сейчас открыт.
      */
      if (p.message?.thread_root_id || view === 'threads') void loadThreads();
    };
    const onDeleted = (p: { chatId: string; messageId: string }) => {
      if (String(p.chatId) !== String(activeId)) return;
      const gone = (list: Message[]) => list.filter((m) => String(m.id) !== String(p.messageId));
      setMessages(gone);
      setThread((prev) => (prev ? { ...prev, messages: gone(prev.messages) } : prev));
    };
    // нас убрали из группы — чат должен исчезнуть, а не висеть открытым с ошибками
    const onRemoved = (p: { chatId: string }) => {
      if (String(p.chatId) === String(activeId)) { setActiveId(null); setMessages([]); }
      reload();
    };
    // закрепление видят все: шапка чата должна измениться сразу у обоих
    const onPinned = (p: { chatId: string }) => {
      if (String(p.chatId) === String(activeId)) loadPinned(String(p.chatId));
    };
    /*
      Напоминание вернулось. Показываем всплывашкой и ведём к самому сообщению:
      напоминание без перехода к тому, о чём оно, — половина дела.
    */
    const onReminder = (p: { chatId: string; messageId: string; author: string | null; body: string }) => {
      showToast({
        title: `Напоминание${p.author ? ` · ${p.author}` : ''}`,
        body: p.body,
        chatId: String(p.chatId),
        section: 'chat',
      });
    };
    // позвали по имени — это адресовано лично, и узнавать об этом надо сразу
    const onMention = (p: { body: string }) => {
      showToast({ title: 'Вас упомянули', body: p.body, section: 'chat' });
      loadInbox();
    };
    // задачу по сообщению завёл кто-то другой — отметка должна появиться и у нас,
    // иначе по той же фразе заведут вторую
    const onTaskLinked = (p: { chatId: string; messageId: string; taskId: string; title: string; projectId?: string }) => {
      if (String(p.chatId) !== String(activeId)) return;
      setMessages((prev) => prev.map((m) => (String(m.id) === String(p.messageId)
        ? { ...m, task_id: String(p.taskId), task_title: p.title, task_project_id: p.projectId ?? null } : m)));
    };
    /*
      Собеседник открыл чат — наши сообщения прочитаны.

      Отмечаем вторую галочку сразу: без этого она появлялась только после
      перезагрузки переписки, и «прочитано» узнавалось с опозданием на час.
    */
    const onRead = (p: { chatId: string; at: string }) => {
      if (String(p.chatId) !== String(activeId)) return;
      const at = new Date(p.at).getTime();
      setMessages((prev) => prev.map((m) => (
        String(m.author_id) === String(user?.id) && new Date(m.created_at).getTime() <= at
          ? { ...m, read_by: Math.max(m.read_by ?? 0, m.others ?? 1) }
          : m
      )));
    };
    socket.on('chat.read', onRead);
    // сообщение поправили в другой вкладке или у собеседника
    const onEdited = (p: { chatId: string; messageId: string; body: string }) => {
      if (String(p.chatId) !== String(activeId)) return;
      const edited = (list: Message[]) => list.map((m) => (String(m.id) === String(p.messageId)
        ? { ...m, body: p.body, edited_at: new Date().toISOString() } : m));
      setMessages(edited);
      setThread((prev) => (prev ? { ...prev, messages: edited(prev.messages) } : prev));
    };
    socket.on('chat.message_edited', onEdited);
    socket.on('chat.task_linked', onTaskLinked);
    socket.on('chat.reminder', onReminder);
    socket.on('chat.mention', onMention);
    socket.on('chat.pinned', onPinned);
    // «печатает…»: состояние на три секунды, продлевается каждым событием
    const onTyping = (p: { chatId: string; userId: string; name: string }) => {
      if (String(p.chatId) !== String(activeId) || String(p.userId) === String(user?.id)) return;
      setTyping((prev) => ({ ...prev, [String(p.userId)]: { name: p.name, until: Date.now() + 3000 } }));
    };
    socket.on('chat.typing', onTyping);
    socket.on('chat.message', onMessage);
    socket.on('chat.message_deleted', onDeleted);
    socket.on('chat.created', reload);
    socket.on('chat.removed', onRemoved);
    /*
      Соединение восстановилось — догоняем пропущенное.

      Пока сокет лежал (сеть моргнула, вкладка спала, прокси разорвал соединение),
      события шли мимо: их никто не повторит. Человек видел переписку такой, какой
      она была в момент обрыва, — и ветки «появлялись только после перезагрузки».
      Перезагрузка помогала не потому, что данные не сохранились, а потому, что
      это был единственный способ перечитать их.

      Перечитываем то, что сейчас на экране: список чатов, открытую переписку,
      открытую ветку и счётчики. Дёшево и ровно в тот момент, когда нужно.
    */
    const onReconnect = () => {
      reload();
      void loadThreads();
      loadInbox();
      if (activeId) {
        api.chatMessages(activeId).then(setMessages).catch(() => undefined);
        // через ссылку, а не через замыкание: ветку могли открыть уже после того,
        // как этот обработчик повесили, и тогда в замыкании лежит пустота
        const open = threadRef.current;
        if (open) void refreshThread(open.rootId).catch(() => undefined);
      }
    };
    socket.on('connect', onReconnect);
    return () => {
      socket.off('chat.typing', onTyping);
      socket.off('connect', onReconnect);
      socket.off('chat.read', onRead);
      socket.off('chat.message_edited', onEdited);
      socket.off('chat.task_linked', onTaskLinked);
      socket.off('chat.reminder', onReminder);
      socket.off('chat.mention', onMention);
      socket.off('chat.pinned', onPinned);
      socket.off('chat.message', onMessage);
      socket.off('chat.message_deleted', onDeleted);
      socket.off('chat.created', reload);
      socket.off('chat.removed', onRemoved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, reload, appendMessage, view, loadPinned, loadInbox]);

  // Ищем с задержкой: запрос на каждую букву кладёт базу и мигает списком.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setFound([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api.searchChatMessages(q)
        .then((r) => setFound(r.items))
        .catch(() => setFound([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  /** Что отложено в этом чате: список нужен и чтобы отменить, и чтобы не забыть. */
  const loadScheduled = useCallback((chatId: string) => {
    api.listScheduled(chatId).then((r) => setScheduled(r.items)).catch(() => setScheduled([]));
  }, []);

  const openChat = useCallback(async (id: string) => {
    setActiveId(id); setErr(''); setMessages([]); setMsgLoading(true); setView('chat');
    const unreadBefore = chatsRef.current.find((c) => String(c.id) === String(id))?.unread ?? 0;
    try {
      const list = await api.chatMessages(id); // чтение помечается на сервере этим же запросом
      setMessages(list);
      setHasOlder(list.length >= 50); // страница полная — значит, выше ещё есть
      setUnreadFrom(firstUnreadId(list, unreadBefore, user?.id));
      loadPinned(id);
      loadScheduled(id); // что я отложил в этот чат — видно сразу, а не после отправки
      // Шапка чата проекта должна отвечать «что это за чат» без похода в карточку проекта.
      api.chatContext(id).then(setCtx).catch(() => setCtx(null));
      reload();
      notifyChatsChanged(); // счётчик в шапке должен упасть сразу
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть чат'); }
    finally { setMsgLoading(false); }
  }, [reload, loadPinned, loadScheduled, user?.id]);

  /*
    Вернулись во вкладку с открытым чатом — значит прочитали.

    Пока вкладка была в фоне, сообщения приходили и оставались непрочитанными
    намеренно: смотреть в другую вкладку не значит читать. А вот возвращение —
    значит, и висящая единица на открытом чате раздражает больше всего.
  */
  useEffect(() => {
    if (!activeId) return;
    const onBack = () => {
      if (document.hidden || !onScreen()) return;
      api.markChatRead(activeId)
        .then(() => { reload(); notifyChatsChanged(); })
        .catch(() => undefined);
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [activeId, reload]);

  // пришли из уведомления — открываем названный чат, а не последний.
  // `anthill` — не чат в базе, а AI-помощник: у него свой экран (ТЗ-6).
  useEffect(() => {
    if (!initialChatId) return;
    if (String(initialChatId) === 'anthill') { setActiveId(null); setMessages([]); setView('anthill'); return; }
    openChat(String(initialChatId));
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
      // Все картинки из буфера, а не первая: вставляют и по нескольку снимков сразу.
      const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!images.length) return;
      e.preventDefault();
      // Открыта ветка — вставляем в НЕЁ: человек смотрит туда, туда и кладём.
      if (thread) { attachToThread(images); return; }
      void attach(images);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, thread]);

  // сменили чат — недоотправленное вложение к новому собеседнику отношения не имеет
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => clearPending, [activeId]);

  // лента всегда прокручена вниз: читают последнее, а не начало переписки
  useEffect(() => {
    if (keepScroll.current) { keepScroll.current = false; return; }
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /** Докрутили до верха — подшиваем страницу старше, не сдвигая то, что перед глазами. */
  const loadOlder = async () => {
    if (!activeId || olderBusy || !hasOlder || !messages.length) return;
    const el = feedRef.current;
    const before = el?.scrollHeight ?? 0;
    setOlderBusy(true);
    try {
      const older = await api.chatMessages(activeId, String(messages[0].id));
      if (older.length < 50) setHasOlder(false);
      if (older.length) {
        keepScroll.current = true;
        setMessages((prev) => [...older, ...prev]);
        requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - before; });
      }
    } catch { /* следующая прокрутка попробует снова */ }
    finally { setOlderBusy(false); }
  };
  // …кроме случая, когда есть непрочитанное: тогда — к черте, чтобы читать с неё,
  // а не мотать вверх в поисках, откуда начинается новое
  useEffect(() => {
    if (!unreadFrom) return;
    const t = window.setTimeout(() => {
      feedRef.current?.querySelector('.chat-unread-line')?.scrollIntoView({ block: 'center' });
    }, 30);
    return () => window.clearTimeout(t);
  }, [unreadFrom, messages.length]);

  /**
   * Отправка.
   *
   * Одно действие на оба случая: есть вложение — уходит файл с подписью, нет —
   * обычное сообщение. Иначе человеку приходится помнить, какой кнопкой отправлять
   * картинку, а какой текст.
   */
  const send = async () => {
    const text = draft.trim();
    if (!activeId || (!text && !pending.length)) return;
    setUnreadFrom(null); // ответил — значит, дочитал: черта больше не нужна
    const files = pending.map((p) => p.file);
    setDraft('');
    clearPending();
    try {
      // «@AI» — обращение к помощнику, а не к человеку: ответ придёт в этот же чат
      // и его увидят все, кто в разговоре.
      if (!files.length && MENTIONS_AI.test(text)) {
        setAiBusy(true);
        try { await api.askChatAi(activeId, text.replace(MENTIONS_AI, ' ').trim() || text); }
        finally { setAiBusy(false); }
        return;
      }
      // Имя могли стереть после вставки — звать человека после этого не за что.
      const calls = stillMentioned(mentioned, text, mentionUsers);
      const reply = replyTo ? { toId: replyTo.id, excerpt: replyTo.excerpt } : undefined;
      const message = files.length
        ? await api.sendChatFile(activeId, files, text, undefined, reply)
        : await api.sendChatMessage(activeId, text, undefined, calls, reply);
      setMentioned([]);
      setReplyTo(null);
      appendMessage(message);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : files.length ? 'Файл не отправлен' : 'Сообщение не отправлено');
      setDraft(text); // не теряем набранное
      if (files.length) void attach(files); // и вложения возвращаем в очередь — переснимать экран обидно
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
  /*
    Снимки ужимаются при выборе — см. lib/image-shrink.

    Десять фотографий с телефона — это полсотни мегабайт и минуты ожидания; после
    сжатия те же десять уходят за пару секунд и выглядят на экране так же.
  */
  const attach = async (file: File | File[]) => {
    const list = await shrinkAll(Array.isArray(file) ? file : [file]);
    const named = list.map((f) => (isAnonymousClipboardName(f.name) && f.type.startsWith('image/')
      ? new File([f], screenshotName(new Date(), f.type), { type: f.type })
      : f));
    // Десять — предел одного сообщения: дальше это уже архив, а не разговор.
    setPending((prev) => [
      ...prev,
      ...named.map((f) => ({ file: f, url: isImageName(f.name) ? URL.createObjectURL(f) : '' })),
    ].slice(0, 10));
  };

  const clearPending = () => setPending((prev) => {
    for (const p of prev) if (p.url) URL.revokeObjectURL(p.url);
    return [];
  });

  /** Убрать одно вложение из очереди: приложил лишнее — не отправлять же всё заново. */
  const dropPending = (idx: number) => setPending((prev) => {
    const gone = prev[idx];
    if (gone?.url) URL.revokeObjectURL(gone.url);
    return prev.filter((_, i) => i !== idx);
  });

  const react = async (messageId: string, emoji: string) => {
    if (!activeId) return;
    // Оптимистично: реакция должна ставиться мгновенно — в этом вся её ценность.
    const patch = (list: Message[]) => list.map((m) => {
      if (String(m.id) !== String(messageId)) return m;
      const next = [...(m.reactions ?? [])];
      const found = next.find((r) => r.emoji === emoji);
      if (found) {
        found.mine ? (found.count -= 1) : (found.count += 1);
        found.mine = !found.mine;
      } else next.push({ emoji, count: 1, mine: true });
      return { ...m, reactions: next.filter((r) => r.count > 0) };
    });
    setMessages(patch);
    setThread((prev) => (prev ? { ...prev, messages: patch(prev.messages) } : prev));
    try { await api.reactToChatMessage(activeId, messageId, emoji); }
    catch { setMessages(await api.chatMessages(activeId)); }
  };

  const toggleSaved = async (m: Message) => {
    if (!activeId) return;
    const id = String(m.id);
    // Оптимистично: «сохранить» — жест на полсекунды, ждать ответа сети незачем.
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    try { await api.saveChatMessage(activeId, id); loadSaved(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); loadSaved(); }
  };

  const remind = async (messageId: string, at: Date) => {
    if (!activeId) return;
    setRemindFor(null);
    try {
      await api.remindAboutMessage(activeId, messageId, at.toISOString());
      showToast({ title: 'Напомню', body: `Вернусь к этому сообщению ${remindLabel(at)}`, section: 'chat' });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось поставить напоминание'); }
  };

  const togglePin = async (m: Message) => {
    if (!activeId) return;
    const next = !m.pinned_at;
    try {
      await api.pinChatMessage(activeId, String(m.id), next);
      setMessages((prev) => prev.map((x) => (String(x.id) === String(m.id)
        ? { ...x, pinned_at: next ? new Date().toISOString() : null } : x)));
      loadPinned(activeId);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось закрепить'); }
  };

  /**
   * Переход по цитате — к исходному сообщению.
   *
   * Если оно уже в ленте, прыгаем сразу, без похода на сервер: мигание
   * перезагруженной ленты в ответ на нажатие выглядит как сбой. Если его в ленте
   * нет (разговор длинный, а цитата — из глубины), поднимаем окно вокруг него.
   */
  const goToQuoted = async (id: string) => {
    const el = feedRef.current?.querySelector(`[data-msg="${id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlight(id);
      window.setTimeout(() => setHighlight((cur) => (cur === id ? null : cur)), 2600);
      return;
    }
    if (activeId) await openFound({ chatId: String(activeId), messageId: id, threadRootId: null });
  };

  /** Переход к сообщению из закреплённого: если оно ещё не подгружено, просто подсветим. */
  const goToMessage = (id: string) => {
    setPinsOpen(false);
    const el = feedRef.current?.querySelector(`[data-msg="${id}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(String(id));
    window.setTimeout(() => setHighlight(null), 2200);
  };

  /** Открыть ветку сообщения: подгружаем целиком, сервер тем же запросом её и отмечает. */
  /**
   * Открыть задачу, заведённую по сообщению.
   *
   * Адрес задачи — `/projects/<проект>/task/<номер>`: без проекта роутер понимает
   * только «раздел проектов» и высаживал человека в списке досок вместо задачи.
   */
  const openTask = (m: Message) => {
    if (!m.task_id) return;
    navigate(m.task_project_id
      ? { section: 'projects', projectId: String(m.task_project_id), taskId: String(m.task_id) }
      : { section: 'projects' });
  };

  /**
   * Отложить набранное сообщение.
   *
   * Текст уходит с глаз сразу — как в мессенджерах: он больше не в поле ввода, а
   * в списке отложенных. Иначе человек, нажав «отправить позже», смотрит на свой
   * текст и не понимает, отправится он сейчас или нет.
   */
  /**
   * Подтвердили выбор времени.
   *
   * Ежедневное считаем от СЕГОДНЯШНЕГО дня: если названное время уже прошло,
   * первая отправка будет завтра — иначе напоминание ушло бы прямо сейчас.
   */
  const confirmLater = () => {
    if (laterRepeat === 'daily') {
      const [h, m] = laterTime.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) { setErr('Укажите время'); return; }
      const at = new Date();
      at.setHours(h, m, 0, 0);
      if (at.getTime() < Date.now() + 60_000) at.setDate(at.getDate() + 1);
      void scheduleDraft(at, 'daily');
      return;
    }
    const at = new Date(laterAt);
    if (Number.isNaN(at.getTime())) { setErr('Укажите дату и время'); return; }
    void scheduleDraft(at, 'none');
  };

  const scheduleDraft = async (at: Date, repeat: 'none' | 'daily' = 'none') => {
    const text = draft.trim();
    if (!text || !activeId) return;
    setLaterOpen(false);
    try {
      await api.scheduleChatMessage(activeId, {
        body: text,
        sendAt: at.toISOString(),
        repeat,
        mentionIds: stillMentioned(mentioned, text, mentionUsers),
      });
      setDraft('');
      setMentioned([]);
      loadScheduled(activeId);
      toastSaved(
        repeat === 'daily' ? 'Буду отправлять каждый день' : 'Отправлю позже',
        repeat === 'daily'
          ? `в ${at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}, начиная с ${remindLabel(at)}`
          : remindLabel(at),
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отложить сообщение');
    }
  };

  /** Отправить отложенное прямо сейчас: передумал ждать. */
  const sendScheduledNow = async (id: string) => {
    try {
      await api.sendScheduledNow(id);
      setScheduled((prev) => prev.filter((x) => x.id !== id));
      if (activeId) setMessages(await api.chatMessages(activeId));
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить'); }
  };

  /** Перенести время: встречу передвинули — напоминание должно ехать за ней. */
  const rescheduleAt = async (id: string, at: Date) => {
    try {
      await api.rescheduleMessage(id, at.toISOString());
      setScheduled((prev) => prev
        .map((x) => (x.id === id ? { ...x, sendAt: at.toISOString() } : x))
        .sort((a2, b2) => new Date(a2.sendAt).getTime() - new Date(b2.sendAt).getTime()));
      toastSaved('Время изменено', remindLabel(at));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось перенести'); }
  };

  const cancelScheduled = async (id: string) => {
    try {
      await api.cancelScheduled(id);
      setScheduled((prev) => prev.filter((x) => x.id !== id));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отменить'); }
  };

  /**
   * Открыть найденное сообщение.
   *
   * Три случая, и все три встречаются: ответ в ветке открываем веткой (в ленте его
   * нет вовсе), старое сообщение — окном вокруг него (иначе человек видит реплику
   * без разговора), свежее просто подсвечиваем в уже загруженной ленте.
   */
  /**
   * «Перейти к сообщению» из карточки задачи: раздел уже открыт, остаётся показать
   * строку. Событием, потому что адрес сообщения в маршруте не живёт.
   */
  useEffect(() => {
    const onJump = (e: Event) => {
      const d = (e as CustomEvent<{ chatId: string; messageId: string }>).detail;
      if (d?.chatId && d?.messageId) void openFound({ chatId: String(d.chatId), messageId: String(d.messageId), threadRootId: null });
    };
    window.addEventListener('teamcrm:chat-jump', onJump);
    return () => window.removeEventListener('teamcrm:chat-jump', onJump);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Карточка задачи или проекта под окном — в ленту одним нажатием. */
  const shareContext = async (kind: 'task' | 'project', id: string) => {
    if (!activeId) return;
    try {
      const message = await api.chatShare(activeId, kind, id);
      appendMessage(message);
      reload();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить карточку'); }
  };

  const openFound = async (hit: { chatId: string; messageId: string; threadRootId: string | null }) => {
    setView('chat');
    setActiveId(hit.chatId);
    setErr('');
    try {
      const list = hit.threadRootId
        ? await api.chatMessages(hit.chatId)
        : await api.chatMessagesAround(hit.chatId, hit.messageId);
      setMessages(list);
      loadPinned(hit.chatId);
      api.chatContext(hit.chatId).then(setCtx).catch(() => setCtx(null));
      if (hit.threadRootId) await openThread(hit.threadRootId);
      setHighlight(hit.messageId);
      /*
        И прокручиваем к нему.

        Раньше сообщение только подсвечивалось, а лента оставалась там, где была:
        человек нажимал на цитату и не понимал, произошло ли хоть что-то. Ждём
        отрисовку: до неё узла с этим id в ленте ещё нет.
      */
      window.setTimeout(() => {
        feedRef.current?.querySelector(`[data-msg="${hit.messageId}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 80);
      // Подсветка гаснет сама: постоянная метка на сообщении ничего не значит.
      setTimeout(() => setHighlight((cur) => (cur === hit.messageId ? null : cur)), 4000);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось открыть сообщение');
    }
  };

  /** Сохранить правку сообщения. Пустой текст — это удаление, и оно отдельной кнопкой. */
  const saveEdit = async (messageId: string) => {
    if (!activeId) return;
    const text = editText.trim();
    if (!text) return;
    try {
      await api.editMessage(activeId, messageId, text);
      const edited = (list: Message[]) => list.map((m) => (String(m.id) === messageId
        ? { ...m, body: text, edited_at: new Date().toISOString() } : m));
      setMessages(edited);
      setThread((prev) => (prev ? { ...prev, messages: edited(prev.messages) } : prev));
      setEditing(null);
    } catch (e) {
      showToast({ title: 'Не удалось изменить', body: e instanceof ApiError ? e.message : 'Ошибка', section: 'chat' });
    }
  };

  const removeMessage = async (messageId: string) => {
    if (!activeId) return;
    if (!window.confirm('Удалить сообщение? У собеседников оно тоже исчезнет.')) return;
    try {
      await api.deleteMessage(activeId, messageId);
      // Ветка — отдельный список сообщений: без этой строки удалённое исчезало
      // только из ленты, а в открытой ветке висело до перезагрузки страницы.
      const gone = (list: Message[]) => list.filter((m) => String(m.id) !== messageId);
      setMessages(gone);
      setThread((prev) => (prev ? { ...prev, messages: gone(prev.messages) } : prev));
    } catch (e) {
      showToast({ title: 'Не удалось удалить', body: e instanceof ApiError ? e.message : 'Ошибка', section: 'chat' });
    }
  };

  /**
   * Значки действий под сообщением.
   *
   * Обычная функция, а не компонент: она закрывает собой все обработчики страницы
   * (реакции, меню, напоминания), и отдельному компоненту пришлось бы передавать
   * полтора десятка пропсов. Живёт в одном месте, потому что используется дважды —
   * в ленте чата и в ветке: заказчик справедливо заметил, что в ветке «нельзя ни
   * смайлы поставить, ни удалить, ни задачу создать».
   */
  /**
   * Что можно сделать с сообщением — пунктами меню.
   *
   * Меню открывается правой кнопкой (на касании — долгим нажатием) и собирается под
   * конкретную реплику: чужую не правят и не удаляют, у своей нет пункта «пометить
   * непрочитанным». Раньше те же действия стояли значками под каждым сообщением —
   * заказчик попросил убрать их совсем и повторить поведение Telegram.
   */
  const messageMenuItems = (m: Message, mine: boolean, picked = '') => [
    {
      label: picked ? 'Ответить с цитатой' : 'Ответить',
      icon: 'reply' as const,
      onClick: () => setReplyTo({
        id: String(m.id),
        author: m.is_ai ? 'AnthillBot' : (m.author_name ?? m.guest_name ?? 'Собеседник'),
        // Цитируем ИМЕННО выделенный кусок: спорят обычно об одном абзаце.
        excerpt: picked || String(m.body ?? 'вложение').slice(0, 600),
      }),
    },
    { label: 'Ответить в ветке', icon: 'chat' as const, onClick: () => { void openThread(String(m.id)); } },
    /*
      Копирование выделенного.

      Своё меню по правой кнопке забрало у браузера его собственное — вместе с
      пунктом «Копировать». Возвращаем: есть выделение — копируем именно его,
      нет — всё сообщение.
    */
    ...(picked ? [{
      label: 'Копировать выделенное',
      icon: 'copy' as const,
      onClick: () => { void navigator.clipboard?.writeText(picked).catch(() => undefined); },
    }] : []),
    ...(m.body ? [{
      label: 'Копировать текст',
      icon: 'copy' as const,
      onClick: () => { void navigator.clipboard?.writeText(String(m.body)).catch(() => undefined); },
    }] : []),
    { label: m.pinned_at ? 'Открепить' : 'Закрепить', icon: 'flag' as const, onClick: () => togglePin(m) },
    {
      label: savedIds.has(String(m.id)) ? 'Убрать из сохранённого' : 'Сохранить',
      icon: 'star' as const,
      onClick: () => toggleSaved(m),
    },
    { label: 'Напомнить', icon: 'clock' as const, onClick: () => setRemindFor(String(m.id)) },
    ...(!mine && !m.is_ai && !m.thread_root_id ? [{
      label: 'Пометить как непрочитанное',
      icon: 'mail' as const,
      onClick: () => { void markUnreadFrom(m); },
    }] : []),
    ...(m.task_id
      ? [{ label: `Задача #${m.task_id}`, icon: 'check' as const, onClick: () => openTask(m) }]
      : [{ label: 'Создать задачу', icon: 'sparkles' as const, onClick: () => setToTask(m) }]),
    ...(mine ? [
      {
        label: 'Изменить',
        icon: 'edit' as const,
        onClick: () => { setEditing(String(m.id)); setEditText(String(m.body ?? '')); },
      },
      { label: 'Удалить', icon: 'trash' as const, danger: true, onClick: () => { void removeMessage(String(m.id)); } },
    ] : []),
  ];

  /**
   * Правая кнопка и долгое нажатие — на самом сообщении, где их и ищут.
   *
   * Выделенный кусок снимаем ЗДЕСЬ, пока он ещё есть: пока человек ведёт мышь к
   * пункту меню, любой щелчок выделение сбрасывает.
   */
  const messageMenuProps = (m: Message) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setCtxFor({
        id: String(m.id),
        at: { x: e.clientX, y: e.clientY },
        picked: selectionIn(e.currentTarget as Element),
      });
    },
    ...longPressProps((at) => setCtxFor({ id: String(m.id), at, picked: '' })),
  });

  /**
   * Перечитать ветку с сервера и выправить счётчик ответов на корне.
   *
   * Счётчик берём от длины ветки, а не прибавляем единицу: прибавление врёт, если
   * событие пришло дважды или не пришло вовсе, а «сколько сейчас в ветке» —
   * единственная величина, которую не надо угадывать.
   */
  const refreshThread = async (rootId: string) => {
    if (!activeId) return;
    const messages = await api.chatThread(activeId, rootId);
    setThread({ rootId: String(rootId), messages });
    setMessages((prev) => prev.map((m) => (String(m.id) === String(rootId)
      ? { ...m, reply_count: Math.max(0, messages.length - 1), last_reply_at: messages[messages.length - 1]?.created_at ?? m.last_reply_at }
      : m)));
  };

  const openThread = async (rootId: string) => {
    if (!activeId) return;
    setInfoOpen(false); // правый слот один: ветка вытесняет сведения
    setThreadBody(''); setAlsoInChannel(false);
    try {
      const messages = await api.chatThread(activeId, rootId);
      setThread({ rootId: String(rootId), messages });
      notifyChatsChanged();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть ветку'); }
  };

  /**
   * Картинки в ветку.
   *
   * Ветка — такая же переписка: показать «вот так съезжает» снимком в ней нужно
   * ничуть не реже, чем в ленте, а раньше приложить файл там было нечем вовсе.
   */
  const attachToThread = (files: File[]) => {
    const named = files.map((f) => (isAnonymousClipboardName(f.name) && f.type.startsWith('image/')
      ? new File([f], screenshotName(new Date(), f.type), { type: f.type })
      : f));
    setThreadPending((prev) => [
      ...prev,
      ...named.map((f) => ({ file: f, url: isImageName(f.name) ? URL.createObjectURL(f) : '' })),
    ].slice(0, 10));
  };

  const clearThreadPending = () => setThreadPending((prev) => {
    for (const p of prev) if (p.url) URL.revokeObjectURL(p.url);
    return [];
  });

  const dropThreadPending = (idx: number) => setThreadPending((prev) => {
    const gone = prev[idx];
    if (gone?.url) URL.revokeObjectURL(gone.url);
    return prev.filter((_, i) => i !== idx);
  });

  const sendToThread = async () => {
    const text = threadBody.trim();
    if ((!text && !threadPending.length) || !thread || !activeId) return;
    const files = threadPending.map((p) => p.file);
    setThreadBody('');
    clearThreadPending();
    try {
      // Вложения и подпись уходят ОДНИМ сообщением — как в ленте чата.
      if (files.length) {
        await api.sendChatFile(activeId, files, text, { rootId: thread.rootId, alsoInChannel });
        await refreshThread(thread.rootId);
        void loadThreads();
        return;
      }
      await api.sendChatMessage(activeId, text, { rootId: thread.rootId, alsoInChannel });
      /*
        Своё не ждём от сокета.

        Раньше ответ в ветке появлялся только эхом события `chat.message`, и пока
        сокет жив, так и происходит — это подтверждено живой проверкой на проде.
        Но сокет иногда мёртв: сеть моргнула, вкладка проснулась, прокси разорвал
        соединение — socket.io переподключится, а событие, ушедшее в эту секунду,
        уже никто не повторит. Тогда ответ уходил на сервер, но не показывался,
        и ветка «появлялась только после перезагрузки».

        Поэтому свою же отправку показываем сами, по ответу сервера: он у нас
        уже есть, и ждать от него второго подтверждения незачем.
      */
      await refreshThread(thread.rootId);
      void loadThreads();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ответ не отправлен');
      setThreadBody(text);
      if (files.length) attachToThread(files); // переснимать экран обидно
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
  /*
    Группировка списка: избранное, каналы, потом всё остальное.

    Канал — тема, которая переживёт состав участников (#разработка, #баги), группа —
    разговор нескольких человек, диалог — переписка двоих. Валить это в один список
    из сорока строк значит каждый раз искать нужное глазами.
  */
  const favorites = chats.filter((c) => c.favorite);
  const rest = chats.filter((c) => !c.favorite);
  const selfChat = rest.find((c) => c.kind === 'self') ?? null;
  const channels = rest.filter((c) => c.kind === 'channel');
  const external = rest.filter((c) => c.kind === 'external');
  const dms = rest.filter((c) => c.kind === 'dm');
  const groups = rest.filter((c) => c.kind === 'group' || c.kind === 'project');
  // с кем ещё не переписывались — показываем ниже, чтобы можно было начать диалог
  const others = useMemo(() => {
    const known = new Set(dms.map((c) => String(c.peerId)));
    return users.filter((u) => String(u.id) !== String(user?.id) && !known.has(String(u.id)));
  }, [users, dms, user]);

  const match = (s: string | null) => !query || (s ?? '').toLowerCase().includes(query.toLowerCase());
  const threadsUnread = threads.reduce((sum, t) => sum + (Number(t.unread) || 0), 0);
  /*
    Помощник стоит в том же списке, что и люди: его зовут через «@», как коллегу.
    Отдельная кнопка «спросить ИИ» делала бы из него инструмент в стороне от разговора,
    хотя он участник этого разговора. Так же сделано в чате задачи.
  */
  const mentionUsers = [
    { id: 'ai', fullName: 'AnthillBot', hint: 'знает эту переписку' },
    ...users.map((u) => ({ id: String(u.id), fullName: u.fullName })),
  ];
  /*
    «Входящие» светятся только личным.

    Заказчик: «должно светиться то, что касается меня — тегнули, написали в личку,
    ответили мне или в ветку, а не просто сообщение в общий чат». Обычная переписка
    считается на самих чатах, и дублировать её сюда значит превращать раздел во
    второй список чатов.
  */
  const inboxTotal = inbox
    ? inbox.counts.mentions + inbox.counts.threads + inbox.counts.dms + inbox.counts.replies
    : 0;
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
  /* Секции списка чатов: строки готовятся здесь, порядок задаёт человек. */
  const rowOf = (c: Chat, withGroup = false) => (
    <ChatRow
      key={c.id} chat={c} active={String(c.id) === String(activeId)}
      group={withGroup && c.kind === 'dm' ? groupFor(c.peerId) : undefined}
      onClick={() => openChat(c.id)} onStar={() => star(c)}
    />
  );
  const unreadOf = (list: Chat[]) => list.reduce((n, c) => n + (Number(c.unread) || 0), 0);
  const sectionsByKey: Record<string, { label: string; count: number; unread: number; rows: React.ReactNode }> = {
    favorites: { label: 'Избранное', count: favorites.filter((c) => match(c.title)).length, unread: unreadOf(favorites), rows: favorites.filter((c) => match(c.title)).map((c) => rowOf(c, true)) },
    channels: { label: 'Каналы', count: channels.filter((c) => match(c.title)).length, unread: unreadOf(channels), rows: channels.filter((c) => match(c.title)).map((c) => rowOf(c)) },
    external: { label: 'Внешние', count: external.filter((c) => match(c.title)).length, unread: unreadOf(external), rows: external.filter((c) => match(c.title)).map((c) => rowOf(c)) },
    dms: { label: 'Личные', count: dms.filter((c) => match(c.title)).length, unread: unreadOf(dms), rows: dms.filter((c) => match(c.title)).map((c) => rowOf(c, true)) },
    groups: { label: 'Группы и проекты', count: groups.filter((c) => match(c.title)).length, unread: unreadOf(groups), rows: groups.filter((c) => match(c.title)).map((c) => rowOf(c)) },
    others: {
      label: 'Написать впервые', count: others.filter((u) => match(u.fullName)).length, unread: 0,
      rows: others.filter((u) => match(u.fullName)).map((u) => (
        <button key={u.id} className="chat-row" onClick={() => writeTo(u.id)}>
          <Avatar path={u.avatarUrl ?? null} fallback={u.fullName[0]?.toUpperCase() ?? '?'} className="avatar-sm" />
          <span className="chat-row-main">
            <span className="chat-row-title">
              {u.fullName}
              {groupFor(u.id) && <span className="chat-row-group">{groupFor(u.id)}</span>}
            </span>
          </span>
        </button>
      )),
    },
  };
  const orderedSections = applyOrder(
    ['favorites', 'channels', 'external', 'dms', 'groups', 'others'].map((section) => ({ section })),
    { order: sectionPrefs.order },
  ).map((x) => x.section);
  // Заметки — чат с собой: ссылки и мысли на потом складывают именно туда,
  // а без него пишут их коллеге «чтобы не потерять».
  const notesRow = selfChat
    ? (
      <ChatRow
        key={selfChat.id} chat={selfChat} active={String(selfChat.id) === String(activeId)}
        onClick={() => openChat(selfChat.id)} onStar={() => star(selfChat)}
      />
    )
    : (
      <button key="notes" className="chat-row" onClick={openNotes} title="Ссылки, файлы и мысли на потом — себе">
        <span className="chat-section-icon" aria-hidden="true"><Icon name="edit" size={15} /></span>
        <span className="chat-row-main">
          <span className="chat-row-title">Заметки</span>
          <span className="chat-row-last dim">чат с собой</span>
        </span>
      </button>
    );
  const listEmpty =
    dms.filter((c) => match(c.title)).length === 0 &&
    groups.filter((c) => match(c.title)).length === 0 &&
    others.filter((u) => match(u.fullName)).length === 0;

  return (
    /*
      На узком экране список чатов и переписка не помещаются рядом: поле ввода
      сжимается до щели. Поэтому там показывается что-то одно — список, пока чат
      не выбран, и переписка, когда выбран. Какое именно, решает этот класс, а не
      отдельное состояние: правда о «что открыто» уже есть в activeId и view.
    */
    <div className={`chats${overlay ? ' chats-overlay' : ''}${activeId || view !== 'chat' ? ' chats-picked' : ''}`}>
      {!overlay && (
      <aside className="chat-list">
        <div className="chat-list-head">
          <input className="input chat-search" placeholder="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn btn-ghost btn-sm" title="Создать группу — разговор нескольких человек" onClick={() => setGroupOpen(true)}>
            <Icon name="plus" />
          </button>
          {/* Канал — тема, которая переживёт состав участников. Витрина рядом:
              публичный канал бесполезен, если о нём никто не знает. */}
          <button className="btn btn-ghost btn-sm" title="Создать канал — общая тема" onClick={() => setChannelOpen(true)}>
            <Icon name="hash" />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Разговор с клиентом или подрядчиком — по ссылке, без доступа к остальному"
            onClick={async () => {
              const title = window.prompt('С кем разговор? Например, «ООО Вектор»');
              if (!title?.trim()) return;
              try {
                const chat = await api.createExternalChat({ title: title.trim() });
                await reload();
                setView('chat');
                openChat(String(chat.id));
              } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось создать разговор'); }
            }}
          >
            <Icon name="link" />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Все каналы компании"
            onClick={() => { setView(view === 'channels' ? 'chat' : 'channels'); loadChannels(); }}
          >
            <Icon name="search" />
          </button>
        </div>

        {/*
          AnthillBot — отдельным собеседником в самом верху списка (ТЗ-6).

          Не кнопка «спросить ИИ» где-то в углу: помощник отвечает в переписке, и
          искать его человек будет там же, где ищет коллегу — в списке чатов.
        */}
        <button
          className={`chat-row chat-row-section chat-row-anthill${view === 'anthill' ? ' active' : ''}`}
          onClick={() => { setView('anthill'); setThread(null); }}
        >
          <span className="chat-section-icon anthill-mark" aria-hidden="true"><Icon name="robot" size={15} /></span>
          <span className="chat-row-main">
            <span className="chat-row-title">AnthillBot</span>
            <span className="chat-row-last dim">AI-помощник</span>
          </span>
        </button>

        {/*
          «Треды» — первым пунктом списка, как в привычных рабочих чатах.
          Отвечают обычно в ветке, а ветку легко не заметить: она не поднимает чат
          наверх и не мигает счётчиком. Этот раздел и отвечает на вопрос «где меня ждут».
        */}
        {SECTIONS.map((sec) => {
          const count = sec.key === 'inbox' ? inboxTotal : sec.key === 'threads' ? threadsUnread : 0;
          return (
            <button
              key={sec.key}
              className={`chat-row chat-row-section${view === sec.key ? ' active' : ''}`}
              onClick={() => {
                setView(view === sec.key ? 'chat' : sec.key);
                setThread(null);
                if (sec.key === 'threads') void loadThreads();
                if (sec.key === 'inbox') loadInbox();
                if (sec.key === 'saved') loadSaved();
              }}
            >
              <span className="chat-section-icon" aria-hidden="true"><Icon name={sec.icon} size={15} /></span>
              <span className="chat-row-main">
                <span className="chat-row-title">{sec.title}</span>
                <span className="chat-row-last dim">{sec.hint}</span>
              </span>
              {count > 0 && <span className="chat-unread">{count}</span>}
            </button>
          );
        })}

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

        {query.trim().length >= 2 && (
          <>
            <div className="chat-group-head">
              Сообщения{searching ? ' · ищу…' : found.length ? ` · ${found.length}` : ''}
            </div>
            {!searching && found.length === 0 && (
              <div className="nav-projects-empty dim">Ничего не нашлось в переписке</div>
            )}
            {found.map((hit) => (
              <button key={hit.messageId} className="chat-hit" onClick={() => openFound(hit)}>
                <span className="chat-hit-head">
                  <b>{hit.chatTitle}</b>
                  <span className="dim chat-time">{dayOf(hit.createdAt)} {timeOf(hit.createdAt)}</span>
                </span>
                <span className="chat-hit-body dim">
                  {hit.authorName ? `${hit.authorName}: ` : ''}{String(hit.body ?? '').slice(0, 140)}
                </span>
                {hit.threadRootId && <span className="dim chat-under-mark"><Icon name="chat" size={11} /> в ветке</span>}
              </button>
            ))}
            {found.length > 0 && <div className="chat-group-head">Чаты</div>}
          </>
        )}


        {/*
          Секции списка — в личном порядке и со сворачиванием (ТЗ-5, раздел 38).

          Заголовок тянется мышью (тот же приём, что у левой панели), нажатие
          сворачивает. Заметки — не секция: одна строка, всегда на месте.
        */}
        {orderedSections.map((key, idx) => {
          const sec = sectionsByKey[key];
          if (!sec || sec.count === 0) return null;
          const collapsed = sectionPrefs.collapsed.includes(key);
          return (
            <div
              key={key}
              className={`chat-section${dragSection === key ? ' dragging' : ''}`}
              onDragOver={(e) => { if (dragSection) e.preventDefault(); }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragSection || dragSection === key) return;
                saveSections({ ...sectionPrefs, order: moveItem(orderedSections, dragSection, idx) });
                setDragSection(null);
              }}
            >
              <button
                className="chat-group-head chat-group-toggle"
                draggable
                onDragStart={(e) => { setDragSection(key); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragSection(null)}
                onClick={() => saveSections({
                  ...sectionPrefs,
                  collapsed: collapsed ? sectionPrefs.collapsed.filter((k) => k !== key) : [...sectionPrefs.collapsed, key],
                })}
                aria-expanded={!collapsed}
                title={collapsed ? 'Развернуть' : 'Свернуть · перетащите, чтобы переставить'}
              >
                <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
                {sec.label}
                {collapsed && sec.unread > 0 && <span className="chat-unread chat-section-unread">{sec.unread}</span>}
              </button>
              {!collapsed && sec.rows}
              {key === 'favorites' && notesRow}
            </div>
          );
        })}
        {!sectionsByKey.favorites?.count && notesRow}

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
      )}

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
          {onClose && (
            <button className="btn btn-ghost btn-sm chat-overlay-close" onClick={onClose} title="Закрыть окно чата (Esc)" aria-label="Закрыть окно чата">
              <Icon name="close" size={16} />
            </button>
          )}
        </div>

        {view === 'inbox' && (
          <div className="threads-view">
            <div className="chat-head">
              <span><Icon name="inbox" size={15} /> <b>Входящие</b></span>
              <button
                className="chat-pins-btn"
                disabled={aiBusy}
                onClick={async () => {
                  setAiBusy(true); setDigest(null); setAiAnswer(null);
                  try { setDigest((await api.aiMissed()).text); }
                  catch (e) { setErr(e instanceof ApiError ? e.message : 'ИИ не ответил'); }
                  finally { setAiBusy(false); }
                }}
                title="Пересказать всё непрочитанное по доступным чатам"
              >
                <Icon name="sparkles" size={13} /> {aiBusy ? 'Читаю…' : 'Что я пропустил'}
              </button>
            </div>

            {digest && (
              <div className="ai-digest">
                <div className="ai-digest-head">
                  <Icon name="sparkles" size={13} /> <b>Что вы пропустили</b>
                  <button className="msg-act" onClick={() => setDigest(null)}>Скрыть</button>
                </div>
                <div className="ai-digest-body">{digest}</div>
              </div>
            )}

            {/* Поиск словами: «где Глеб писал пароль от стенда». Обычный поиск ищет
                по буквам, а спрашивают обычно смыслом — и не помнят точных слов. */}
            <div className="ai-ask">
              <input
                className="input"
                value={aiQuery}
                onChange={(e) => setAiQuery(e.target.value)}
                placeholder="Спросить по переписке: где мы решили про авторизацию?"
                onKeyDown={async (e) => {
                  if (e.key !== 'Enter' || !aiQuery.trim()) return;
                  setAiBusy(true); setAiAnswer(null); setDigest(null);
                  try { setAiAnswer(await api.aiSearchChats(aiQuery.trim())); }
                  catch (err2) { setErr(err2 instanceof ApiError ? err2.message : 'ИИ не ответил'); }
                  finally { setAiBusy(false); }
                }}
              />
            </div>

            {aiAnswer && (
              <div className="ai-digest">
                <div className="ai-digest-head">
                  <Icon name="sparkles" size={13} /> <b>Ответ по переписке</b>
                  <button className="msg-act" onClick={() => setAiAnswer(null)}>Скрыть</button>
                </div>
                <div className="ai-digest-body">{aiAnswer.answer}</div>
                {/* Ссылки настоящие: ответ модели без перехода к первоисточнику
                    проверить нельзя, а в рабочей переписке это обязательно. */}
                {aiAnswer.refs.map((r) => (
                  <button
                    key={r.messageId}
                    className="ai-ref"
                    onClick={() => { setView('chat'); void openChat(String(r.chatId)); }}
                  >
                    <b>{r.chat}</b> · {r.author ?? 'система'} · {new Date(r.at).toLocaleDateString('ru-RU')}
                    <span className="dim"> — {r.text.slice(0, 90)}</span>
                  </button>
                ))}
              </div>
            )}
            {inboxTotal === 0 && (
              <EmptyState
                compact
                icon="check"
                title="Всё разобрано"
                hint="Сюда попадает только личное: где позвали по имени, написали в личку, ответили на ваше сообщение или в вашей ветке. Общие чаты считаются отдельно — в списке слева."
              />
            )}
            {inbox && inbox.mentions.length > 0 && (
              <>
                <div className="chat-group-head">Вас упомянули</div>
                {inbox.mentions.map((m: any) => (
                  <button
                    key={m.id}
                    className={`thread-item${m.seen_at ? '' : ' thread-item-new'}`}
                    onClick={() => { void openChat(String(m.chat_id)); }}
                  >
                    <span className="thread-item-head">
                      <b>{m.project_name ?? m.chat_title ?? 'Личный диалог'}</b>
                      {!m.seen_at && <span className="chat-unread">новое</span>}
                    </span>
                    <span className="thread-item-body dim">{m.author_name}: {String(m.body ?? '').slice(0, 120)}</span>
                  </button>
                ))}
              </>
            )}
            {inbox && inbox.threads.length > 0 && (
              <>
                <div className="chat-group-head">Ответили в ветке</div>
                {inbox.threads.map((t: any) => (
                  <button
                    key={t.root_id}
                    className="thread-item"
                    onClick={() => { void openChat(String(t.chat_id)).then(() => openThread(String(t.root_id))); }}
                  >
                    <span className="thread-item-head">
                      <b>{t.project_name ?? t.chat_title ?? 'Личный диалог'}</b>
                      <span className="chat-unread">{t.unread}</span>
                    </span>
                    <span className="thread-item-body dim">{t.root_author}: {String(t.root_body ?? '').slice(0, 120)}</span>
                  </button>
                ))}
              </>
            )}
            {inbox && inbox.replies.length > 0 && (
              <>
                <div className="chat-group-head">Ответили вам</div>
                {inbox.replies.map((r: any) => (
                  <button key={r.id} className="thread-item" onClick={() => { void openChat(String(r.chat_id)); }}>
                    <span className="thread-item-head">
                      <b>{r.chat_title ?? r.peer_name ?? r.project_name ?? 'Личный диалог'}</b>
                      <span className="chat-unread">новое</span>
                    </span>
                    <span className="thread-item-body dim">{r.author_name}: {String(r.body ?? '').slice(0, 120)}</span>
                    {/* На что ответили — второй строкой: без этого «да, согласен» ни о чём. */}
                    {r.my_body && (
                      <span className="thread-item-foot dim">в ответ на ваше: {String(r.my_body).slice(0, 80)}</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {inbox && inbox.dms.length > 0 && (
              <>
                <div className="chat-group-head">Личные сообщения</div>
                {inbox.dms.map((c: any) => (
                  <button key={c.id} className="thread-item" onClick={() => { void openChat(String(c.id)); }}>
                    <span className="thread-item-head">
                      <b>{c.peer_name ?? c.title ?? 'Личный диалог'}</b>
                      <span className="chat-unread">{c.unread}</span>
                    </span>
                    <span className="thread-item-body dim">{c.last_author}: {String(c.last_body ?? '').slice(0, 120)}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {view === 'channels' && (
          <div className="threads-view">
            <div className="chat-head"><span><Icon name="hash" size={15} /> <b>Все каналы</b></span></div>
            {channelList.length === 0 && (
              <EmptyState
                compact
                icon="hash"
                title="Публичных каналов пока нет"
                hint="Канал — общая тема компании: #разработка, #маркетинг, #баги. В публичный входят сами, в закрытый приглашают."
              />
            )}
            {channelList.map((c) => (
              <div key={c.id} className="thread-item channel-item">
                <span className="thread-item-head">
                  <b># {c.title}</b>
                  <span className="dim">{c.members} участн.</span>
                </span>
                {c.description && <span className="thread-item-body dim">{c.description}</span>}
                <span className="thread-item-foot">
                  {c.joined
                    ? <button className="btn btn-ghost btn-sm" onClick={() => { setView('chat'); openChat(String(c.id)); }}>Открыть</button>
                    : <button className="btn btn-sm" onClick={() => join(String(c.id))}>Вступить</button>}
                </span>
              </div>
            ))}
          </div>
        )}

        {view === 'saved' && (
          <div className="threads-view">
            <div className="chat-head"><span><Icon name="star" size={15} /> <b>Сохранённое</b></span></div>
            {saved.length === 0 && (
              <EmptyState
                compact
                icon="star"
                title="Пока пусто"
                hint="Сохраняйте сообщения, из которых не получается задача: ссылку на макет, доступы, решение по спорному вопросу. Кнопка «Сохранить» — под сообщением."
              />
            )}
            {saved.map((m: any) => (
              <button key={m.id} className="thread-item" onClick={() => { void openChat(String(m.chat_id)); }}>
                <span className="thread-item-head">
                  <b>{m.project_name ?? m.chat_title ?? 'Личный диалог'}</b>
                </span>
                <span className="thread-item-body dim">
                  {m.author_name}: {String(m.body || m.file_name || 'вложение').slice(0, 120)}
                </span>
              </button>
            ))}
          </div>
        )}

        {view === 'threads' && (
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
                onClick={() => { void openChat(String(t.chat_id)).then(() => openThread(String(t.root_id))); }}
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

        {view === 'anthill' && (
          <AnthillPanel
            fullscreen
            context={context?.taskId
              ? { type: 'task', id: context.taskId }
              : context?.projectId ? { type: 'project', id: context.projectId } : null}
            onClose={onClose ?? (() => setView('chat'))}
          />
        )}

        {!active && view === 'chat' && (
          <div className="chat-empty">
            <EmptyState
              icon="chat"
              title="Выберите, кому написать"
              hint="Слева — личные диалоги и группы. Чтобы собрать несколько человек, нажмите «+» над списком. Из любого чата можно позвонить — с ИИ, который запишет разговор."
            />
          </div>
        )}
        {active && view === 'chat' && (
          <>
            <div className="chat-head">
              {/* Назад к списку: на телефоне переписка занимает весь экран, и вернуться
                  к выбору собеседника иначе нечем. На широком экране кнопки нет. */}
              <button
                className="btn btn-ghost btn-sm chat-back"
                onClick={() => { setActiveId(null); setMessages([]); setThread(null); }}
                title="К списку чатов"
                aria-label="К списку чатов"
              >
                <Icon name="chevron-left" size={16} />
              </button>
              {/*
                Поиск ВНУТРИ открытого чата — как лупа в шапке мессенджера.

                Глобальный поиск слева отвечает на «где это вообще было», а этот —
                на «найди в этом разговоре». Разные вопросы, поэтому и места разные.
              */}
              {inChatSearch && (
                <span className="chat-insearch">
                  <Icon name="search" size={14} />
                  <input
                    className="input"
                    autoFocus
                    placeholder={`Поиск в «${active.title ?? 'чате'}»`}
                    value={inChatQuery}
                    onChange={(e) => setInChatQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setInChatSearch(false); setInChatQuery(''); } }}
                  />
                  <span className="dim">
                    {inChatQuery.trim().length < 2 ? 'введите два знака'
                      : `${inChatHits.length} ${plural(inChatHits.length, 'совпадение', 'совпадения', 'совпадений')}`}
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setInChatSearch(false); setInChatQuery(''); }}
                    title="Закрыть поиск"
                    aria-label="Закрыть поиск"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </span>
              )}
              <span>
                {active.kind === 'dm' && <span className={`presence ${active.peerOnline ? 'on' : ''}`} title={active.peerOnline ? 'в сети' : 'не в сети'} />}
                <b>{active.title ?? 'Чат'}</b>
                {active.kind === 'dm' && groupFor(active.peerId) && (
                  <span className="chat-row-group">{groupFor(active.peerId)}</span>
                )}
                {/* Чат знает, с какой сущностью CRM он связан, — этим он и отличается
                    от обычного мессенджера: статус и горящие задачи видно сразу. */}
                {active.kind === 'project' && ctx?.project_id && (
                  <>
                    <span className="badge badge-muted" style={{ marginLeft: 6 }}>
                      {ctx.status === 'archived' ? 'в архиве' : 'проект'}
                    </span>
                    {ctx.client_name && <span className="chat-row-group">{ctx.client_name}</span>}
                    <span className="dim chat-ctx">
                      {ctx.owner_name && <span title="Ответственный за проект">ответственный: {ctx.owner_name} · </span>}
                      задач в работе: {ctx.open_tasks}
                      {ctx.overdue > 0 && <span className="chat-ctx-overdue"> · просрочено: {ctx.overdue}</span>}
                      {ctx.nearest_deadline && <span> · ближайший срок: {new Date(ctx.nearest_deadline).toLocaleDateString('ru-RU')}</span>}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigate({ section: 'projects', projectId: String(ctx.project_id) })}
                      title="Открыть доску проекта"
                    >
                      <Icon name="board" size={14} /> Проект
                    </button>
                  </>
                )}
                {active.kind === 'project' && !ctx?.project_id && <span className="badge badge-muted" style={{ marginLeft: 6 }}>проект</span>}
                {/* Лупа: поиск по этому разговору. */}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setInChatSearch((v) => !v)}
                  title="Поиск в этом чате"
                  aria-label="Поиск в этом чате"
                >
                  <Icon name="search" size={14} />
                </button>
                {/* Сведения о чате: участники по ролям, материалы, закреплённое, история.
                    Раньше шестерёнка открывала окно только у групп — сайдбар есть у любого чата. */}
                <button
                  className={`btn btn-ghost btn-sm${infoOpen ? ' active' : ''}`}
                  title="Сведения о чате: участники, файлы, закреплённое"
                  aria-label="Сведения о чате"
                  aria-pressed={infoOpen}
                  onClick={() => { setInfoOpen((v) => !v); if (!infoOpen) { setThread(null); clearThreadPending(); } }}
                >
                  <Icon name="info" size={15} />
                </button>
              </span>
              {/* Закреплённое — в шапке: доступы к серверу и ссылку на макет ищут
                  прокруткой на сотню сообщений назад, и это самая частая потеря времени. */}
              {/* «47 непрочитанных» не отвечает на единственный вопрос, который человек
                  задаёт, открывая чат после отпуска: что там решили и что от меня хотят. */}
              {(active.unread > 0 || digest) && (
                <button
                  className="chat-pins-btn"
                  disabled={aiBusy}
                  onClick={async () => {
                    setAiBusy(true); setDigest(null);
                    try { setDigest((await api.chatAiDigest(String(active.id))).text); }
                    catch (e) { setErr(e instanceof ApiError ? e.message : 'ИИ не ответил'); }
                    finally { setAiBusy(false); }
                  }}
                  title="Пересказать непрочитанное в этом чате"
                >
                  <Icon name="sparkles" size={13} /> {aiBusy ? 'Читаю…' : 'Кратко'}
                </button>
              )}
              {pinned.length > 0 && (
                <button className="chat-pins-btn" onClick={() => setPinsOpen((v) => !v)} title="Закреплённые сообщения">
                  <Icon name="flag" size={13} /> Закреплено: {pinned.length}
                </button>
              )}
              {/* Кнопки созвона стоят в шапке раздела — одни на все чаты,
                  чтобы не повторять их в каждой переписке. */}
            </div>

            {/*
              Предупреждение, а не бейдж.

              Сотрудник должен видеть, что здесь его читает клиент, ДО того как напишет
              «они опять всё переиграли». Это единственное место, где полоса поперёк
              экрана оправдана: цена ошибки — испорченные отношения с заказчиком.
            */}
            {active.kind === 'external' && (
              <div className="chat-external-warn">
                <Icon name="alert" size={14} />
                Здесь есть человек со стороны — он видит всё, что вы напишете.
                Внутреннее обсуждение ведите в чате проекта.
              </div>
            )}

            {pinsOpen && pinned.length > 0 && (
              <div className="chat-pins" data-pop>
                {pinned.map((m) => (
                  <button key={m.id} className="chat-pin-item" onClick={() => goToMessage(String(m.id))}>
                    <b>{m.author_name}</b>: {String(m.body || m.file_name || 'вложение').slice(0, 120)}
                  </button>
                ))}
              </div>
            )}

            {digest && (
              <div className="ai-digest">
                <div className="ai-digest-head">
                  <Icon name="sparkles" size={13} /> <b>Кратко о непрочитанном</b>
                  <button className="msg-act" onClick={() => setDigest(null)}>Скрыть</button>
                </div>
                <div className="ai-digest-body">{digest}</div>
              </div>
            )}

            {err && <div className="error-text" style={{ padding: '0 12px' }}>{err}</div>}

            {/*
              Меню сообщения — одно на страницу: и для ленты, и для ветки. Ищем реплику
              в обоих списках, потому что правой кнопкой её могли позвать откуда угодно.
            */}
            {ctxFor && (() => {
              const m = messages.find((x) => String(x.id) === ctxFor.id)
                ?? thread?.messages.find((x) => String(x.id) === ctxFor.id);
              if (!m) return null;
              return (
                <MessageMenu
                  at={ctxFor.at}
                  reactions={REACTIONS}
                  onReact={(emoji) => react(String(m.id), emoji)}
                  items={messageMenuItems(m, String(m.author_id) === String(user?.id), ctxFor.picked)}
                  onClose={() => setCtxFor(null)}
                />
              );
            })()}

            <div className="chat-feed" ref={feedRef} onScroll={(e) => { closePops(); if (e.currentTarget.scrollTop < 80) void loadOlder(); }}>
              {olderBusy && <div className="dim chat-older">Загружаю более ранние…</div>}
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
                /*
                  Итог созвона — карточкой, а не серой строчкой.

                  Разговор закончился, и его результат должен вернуться туда, где
                  договаривались созвониться: сколько шёл, о чём договорились, что
                  предложено сделать. Иначе разбор оседает в разделе встреч, куда надо
                  специально пойти, и половина договорённостей теряется.
                */
                if (m.meeting_id) {
                  const [head, ...rest] = String(m.body ?? '').split('\n');
                  return (
                    <div key={m.id} data-msg={String(m.id)}>
                      {newDay && <div className="chat-day">{dayOf(m.created_at)}</div>}
                      <div className="meet-card">
                        <div className="meet-card-head">
                          <Icon name="record" size={14} /> <b>{head}</b>
                          <span className="chat-time" title={new Date(m.created_at).toLocaleString('ru-RU')}>{stampLabel(m.created_at)}</span>
                        </div>
                        {rest.filter(Boolean).map((line, k) => (
                          <div key={k} className="meet-card-line">{line}</div>
                        ))}
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => navigate({ section: 'chat', view: 'meetings' })}
                          title="Стенограмма, сводка и предложенные задачи"
                        >
                          <Icon name="list" size={13} /> Открыть разбор
                        </button>
                      </div>
                    </div>
                  );
                }
                // системная строка (кого добавили, кто вышел) — без автора и без «пузыря»
                if (!m.author_id && !m.guest_name) {
                  return (
                    <div key={m.id}>
                      {newDay && <div className="chat-day">{dayOf(m.created_at)}</div>}
                      <div className="chat-system">{m.body}</div>
                    </div>
                  );
                }
                const isNew = unreadIndex >= 0 && i >= unreadIndex && !mine;
                return (
                  <div key={m.id} data-msg={String(m.id)}>
                    {newDay && <div className="chat-day">{dayOf(m.created_at)}</div>}
                    {/* Черта, как в Telegram: отсюда и ниже — то, чего вы ещё не видели. */}
                    {unreadFrom === String(m.id) && <div className="chat-unread-line">Непрочитанные сообщения</div>}
                    {/* Время — ПОД плашкой, а не внутри неё: серая строчка на цветном
                        пузыре не читалась вовсе, а место в углу отъедала. */}
                    <div className={`chat-line ${mine && !m.is_ai ? 'mine' : ''}${highlight === String(m.id) ? ' chat-found' : ''}${inChatHits.some((h) => h.id === m.id) ? ' chat-match' : ''}${isNew ? ' chat-new' : ''}`}>
                      <div
                        className={`chat-msg ${mine && !m.is_ai ? 'mine' : ''}${m.is_ai ? ' chat-msg-ai' : ''}`
                          + `${ctxFor?.id === String(m.id) ? ' msg-ctx-open' : ''}`}
                        {...messageMenuProps(m)}
                      >
                        {m.is_ai && <div className="chat-author"><Icon name="robot" size={11} /> AnthillBot</div>}
                        {/* Кто именно писал со стороны: через месяц «внешний участник»
                            без имени в переписке не значит ничего. */}
                        {m.guest_name && (
                          <div className="chat-author chat-author-guest">
                            <Icon name="user" size={11} /> {m.guest_name} · внешний участник
                          </div>
                        )}
                        {m.pinned_at && <span className="chat-pin-mark" title="Закреплено в шапке чата"><Icon name="flag" size={11} /></span>}
                        {!mine && !m.is_ai && active.kind !== 'dm' && <div className="chat-author">{m.author_name}</div>}
                        {/* Шапка ответа: кому отвечают и что именно сказали. Нажатие
                            ведёт к исходной реплике — иначе цитата обрывается ни на чём. */}
                        {m.reply_to_id && m.reply_body && (
                          <button
                            className="msg-quote"
                            onClick={() => void goToQuoted(String(m.reply_to_id))}
                            title="Перейти к исходному сообщению"
                          >
                            <b className="msg-quote-author">{m.reply_author ?? 'Собеседник'}</b>
                            <span className="msg-quote-text">{String(m.reply_body).slice(0, 200)}</span>
                          </button>
                        )}
                        {/* Ссылку в переписке нажимают, а не выделяют и копируют:
                            разбор тот же, что в карточке задачи. */}
                        {m.body && editing !== String(m.id) && <MessageText text={m.body} className="chat-body" />}
                        {/* Правка своего сообщения — прямо в пузыре: уводить человека
                            в отдельное окно ради опечатки незачем. */}
                        {editing === String(m.id) && (
                          <div
                            className="chat-edit"
                            /*
                              Esc отменяет правку — но только если подсказка «@» закрыта:
                              в открытом списке Esc закрывает его и отмечает событие
                              обработанным, иначе один Esc делал бы два дела сразу.
                            */
                            onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) setEditing(null); }}
                          >
                            {/*
                              Правим тем же полем, что и пишем.

                              Простая textarea не знала «@»: дописать упоминание в уже
                              отправленном сообщении было нельзя — приходилось удалять и
                              писать заново. Поле одно и то же, значит и повадки одни.
                            */}
                            <MentionField
                              value={editText}
                              users={mentionUsers}
                              onChange={setEditText}
                              onMention={(userId) => {
                                if (userId === 'ai') return;
                                setMentioned((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
                              }}
                              rows={2}
                              autoGrow
                              onEnter={() => { void saveEdit(String(m.id)); }}
                            />
                            <div className="chat-edit-actions">
                              <button className="btn btn-primary btn-sm" onClick={() => saveEdit(String(m.id))}>Сохранить</button>
                              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Отмена</button>
                            </div>
                          </div>
                        )}
                        {/* Ссылкой файл открыть было нельзя: он за авторизацией и отдавал 401.
                            Картинка теперь видна сразу, остальное скачивается по нажатию. */}
                        {/* Несколько картинок — одно сообщение, как в мессенджерах.
                            Старые сообщения приходят с одним файлом и показываются так же. */}
                        {(m.files?.length ? m.files : m.file_id ? [{ fileId: String(m.file_id), name: m.file_name ?? 'файл' }] : []).map((f) => (
                          <ChatAttachment
                            key={f.fileId}
                            fileId={f.fileId}
                            fileName={f.name ?? 'файл'}
                            onOpen={(url, name, mime) => setPreview({ url, name, mime })}
                          />
                        ))}
                      </div>
                      {/* Поставленные реакции видны всегда: в них весь смысл — ответить
                          «понял», не засоряя переписку и не будя всех уведомлением. */}
                      {(m.reactions ?? []).length > 0 && (
                        <div className={`chat-reactions ${mine ? 'mine' : ''}`}>
                          {(m.reactions ?? []).map((r) => (
                            <button
                              key={r.emoji}
                              className={r.mine ? 'reaction mine' : 'reaction'}
                              onClick={() => react(String(m.id), r.emoji)}
                              title={r.mine ? 'Снять свою реакцию' : 'Поддержать'}
                            >
                              {r.emoji} {r.count}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="chat-under">
                        <span className="chat-time" title={new Date(m.created_at).toLocaleString('ru-RU')}>{stampLabel(m.created_at)}</span>
                        {m.edited_at && <span className="dim chat-under-mark" title="Сообщение изменено">изменено</span>}
                        {/*
                          Две галочки — как в мессенджерах: одна «отправлено», две
                          «прочитали все собеседники». Считается по отметке «был в чате
                          после этого сообщения»: отдельной записи на каждое прочтение
                          ради галочки заводить незачем.

                          В чате проекта участников поимённо нет — там показываем одну
                          галочку и не врём про прочтение.
                        */}
                        {mine && !m.is_ai && (
                          (m.others ?? 0) > 0 && (m.read_by ?? 0) >= (m.others ?? 0) ? (
                            <span className="chat-ticks read" title={`Прочитали все (${m.read_by})`}>
                              <Icon name="check" size={12} /><Icon name="check" size={12} />
                            </span>
                          ) : (
                            <span
                              className="chat-ticks"
                              title={(m.others ?? 0) > 0
                                ? `Прочитали ${m.read_by ?? 0} из ${m.others}`
                                : 'Отправлено'}
                            >
                              <Icon name="check" size={12} />
                              {(m.read_by ?? 0) > 0 && <Icon name="check" size={12} />}
                            </span>
                          )
                        )}



                        {/* Ответы в ветке — не действие, а состояние разговора:
                            строчка остаётся на виду, её не прячут в меню. */}
                        {!!m.reply_count && (
                          <button className="chat-thread-link" onClick={() => openThread(String(m.id))}>
                            <Icon name="chat" size={12} /> {m.reply_count} {plural(m.reply_count, 'ответ', 'ответа', 'ответов')}
                          </button>
                        )}
                        {!!m.task_id && (
                          <button
                            className="chat-thread-link"
                            onClick={() => openTask(m)}
                            title={m.task_title ?? 'Открыть задачу'}
                          >
                            <Icon name="check" size={12} /> Задача #{m.task_id}
                          </button>
                        )}
                        {m.pinned_at && <span className="dim chat-under-mark"><Icon name="flag" size={11} /> закреплено</span>}

                        {/* Выбор времени напоминания разворачивается на месте: отдельное
                            окно ради четырёх вариантов — лишний шаг. */}
                        {remindFor === String(m.id) && (
                          <span className="chat-remind-pick" onClick={(e) => e.stopPropagation()}>
                            {remindOptions().map((o) => (
                              <button key={o.key} className="chat-thread-link" onClick={() => remind(String(m.id), o.at)}>
                                {o.label}
                              </button>
                            ))}
                            <button className="chat-thread-link chat-thread-new" onClick={() => setRemindFor(null)}>Отмена</button>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Идёт запись — это должно быть видно без сомнений: человек говорит вслух,
                и «пишется или нет» он обязан понимать сразу. */}
            {(clip.recording || clipBusy || clip.error) && (
              <div className="chat-clip-state">
                {clip.recording && (
                  <>
                    <span className="chat-clip-dot" aria-hidden="true" />
                    {clip.recording === 'voice' ? 'Говорите…' : 'Идёт запись экрана…'}
                    <button className="msg-act" onClick={clip.stop}>Остановить и отправить</button>
                  </>
                )}
                {clipBusy && <span className="dim">Отправляю и расшифровываю…</span>}
                {clip.error && <span className="error-text">{clip.error}</span>}
              </div>
            )}

            {/* Вложение перед отправкой: видно, что именно уйдёт, и можно подписать.
                Отправлять вслепую — верный способ прислать не тот скриншот. */}
            {pending.length > 0 && (
              <div className="chat-pending">
                {pending.map((p, i) => (
                  <span key={`${p.file.name}-${i}`} className="chat-pending-item">
                    {p.url
                      ? <img className="chat-pending-img" src={p.url} alt={p.file.name} />
                      : <Icon name="paperclip" size={16} />}
                    <span className="chat-pending-name">
                      {p.file.name} <span className="dim">· {humanSize(p.file.size)}</span>
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => dropPending(i)}
                      title="Убрать это вложение"
                      aria-label="Убрать вложение"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
                {pending.length > 1 && (
                  <button className="chat-thread-link" onClick={clearPending}>Убрать все ({pending.length})</button>
                )}
              </div>
            )}

            {typingNames.length > 0 && (
              <div className="chat-typing" aria-live="polite">
                <span className="chat-typing-dots" aria-hidden="true"><i /><i /><i /></span>
                {typingNames.length === 1 ? `${typingNames[0]} печатает…` : `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? ` и ещё ${typingNames.length - 2}` : ''} печатают…`}
              </div>
            )}
            {/* Контекст страницы: задача или проект под окном — в чат одной кнопкой (ТЗ-5, раздел 30). */}
            {overlay && context && (context.taskId || context.projectId) && (
              <div className="chat-context-row">
                {context.taskId && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void shareContext('task', String(context.taskId))} title="Отправить карточку задачи в этот чат">
                    <Icon name="check-circle" size={13} /> Отправить задачу #{context.taskId}
                  </button>
                )}
                {context.projectId && !context.taskId && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void shareContext('project', String(context.projectId))} title="Отправить карточку проекта в этот чат">
                    <Icon name="board" size={13} /> Отправить проект
                  </button>
                )}
              </div>
            )}
            {/* Кому отвечаем — видно над полем, с именем, куском реплики и отменой. */}
            {replyTo && (
              <div className="comment-reply-to chat-reply-to">
                <Icon name="reply" size={13} />
                <span className="reply-to-body">
                  <b>{replyTo.author}</b>
                  <span className="dim"> · {replyTo.excerpt.slice(0, 120)}</span>
                </span>
                <button className="msg-act" onClick={() => setReplyTo(null)} title="Не отвечать" aria-label="Отменить ответ">
                  <Icon name="close" size={13} />
                </button>
              </div>
            )}
            <div
              className="chat-input"
              // Файл можно и перетащить — то же действие, что и вставка из буфера.
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void attach(f); } }}
            >
              <label className="btn btn-ghost btn-sm" title="Прикрепить файл" style={{ cursor: 'pointer' }}>
                <Icon name="paperclip" size={16} />
                <input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.currentTarget.value = ''; }} />
              </label>
              {/*
                Подсказка по «@» — как в ленте компании и в чате задачи.
                Позвать человека по имени в чате на сто сообщений в день — единственный
                способ до него достучаться; сам он это сообщение не найдёт.
              */}
              <MentionField
                className="chat-mention-input"
                value={draft}
                users={mentionUsers}
                onChange={(v) => { setDraft(v); if (v.trim()) noteTyping(); }}
                onMention={(userId) => {
                  if (userId === 'ai') return; // помощник участником чата не становится
                  setMentioned((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
                }}
                placeholder={pending ? 'Подпись к вложению…' : 'Сообщение… «@» — позвать по имени'}
                onEnter={send}
                // Enter отправляет, Shift+Enter переносит строку — как в мессенджерах.
                autoGrow
              />
              {/*
                Второстепенные действия — голосовое, AI голосом, запись экрана, отложить.

                В окне поверх CRM они не помещаются в строку: поле ввода сжималось до
                щели, а кнопки стояли лесенкой — заказчик назвал это «бардак». Там они
                живут за одной кнопкой «+», в разделе — как раньше, в ряд.
              */}
              {overlay && (
                <button
                  className={`btn btn-ghost btn-sm${extraOpen ? ' active' : ''}`}
                  onClick={() => setExtraOpen((v) => !v)}
                  title={extraOpen ? 'Скрыть действия' : 'Ещё: голосовое, AI, запись экрана, отложить'}
                  aria-label="Ещё действия"
                  aria-expanded={extraOpen}
                >
                  <Icon name={extraOpen ? 'close' : 'plus'} size={16} />
                </button>
              )}
              <span className={`chat-input-extra${overlay ? ' chat-input-extra-overlay' : ''}${extraOpen ? ' open' : ''}`}>
              {/* Голосовое: сказать быстрее, чем напечатать, — но только если сказанное
                  потом можно найти. Расшифровка приходит с сервера в тело сообщения. */}
              <button
                className={clip.recording === 'voice' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                onClick={() => (clip.recording ? clip.stop() : clip.start('voice'))}
                disabled={clipBusy}
                title={clip.recording === 'voice' ? 'Остановить и отправить' : 'Голосовое сообщение'}
                aria-label="Голосовое сообщение"
              >
                <Icon name={clip.recording === 'voice' ? 'stop' : 'mic'} size={16} />
              </button>
              {/* Спросить помощника голосом: вопрос расшифровывается и уходит как «@AI». */}
              <button
                className={aiVoice.recording ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                onClick={aiVoice.toggle}
                disabled={aiBusy || aiVoice.transcribing || !!clip.recording}
                title={aiVoice.recording ? 'Остановить и спросить' : aiVoice.transcribing ? 'Расшифровываю вопрос…' : 'Спросить AI голосом'}
                aria-label="Спросить AI голосом"
              >
                <Icon name={aiVoice.recording ? 'stop' : 'robot'} size={16} />
              </button>
              {/* Запись экрана: «вот нажимаю кнопку, и всё зависает» показать проще,
                  чем описать словами. Из такого сообщения потом делают задачу. */}
              <button
                className={clip.recording === 'screen' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                onClick={() => (clip.recording ? clip.stop() : clip.start('screen'))}
                disabled={clipBusy}
                title={clip.recording === 'screen' ? 'Остановить и отправить' : 'Записать экран с голосом'}
                aria-label="Записать экран"
              >
                <Icon name="screen" size={16} />
              </button>
              {/*
                Полоска «отложено: N» над полем — как в мессенджерах.

                Раньше здесь висели сами сообщения строчками, и что с ними делать
                было непонятно. Теперь одна строка открывает окно, где отложенные
                показаны как сообщения: отправить сейчас, перенести, удалить.
              */}
              {scheduled.length > 0 && (
                <button className="chat-later-queue" onClick={() => setQueueOpen(true)}>
                  <Icon name="clock" size={12} />
                  Отложено: {scheduled.length} · ближайшее {laterLabel(scheduled[0])}
                </button>
              )}
              {/*
                Отправить позже — как в мессенджерах.

                Рядом с «отправить», а не в меню: решение «сейчас или потом»
                принимают в тот же момент, что и решение отправить.
              */}
              <span className="chat-later">
                <button
                  className="btn btn-ghost btn-sm chat-later-btn"
                  onClick={() => setLaterOpen((v) => !v)}
                  disabled={!draft.trim()}
                  title="Отправить позже — напомнить о встрече, написать утром"
                  aria-label="Отправить позже"
                >
                  <Icon name="clock" size={16} />
                </button>
                {laterOpen && (
                  <span className="chat-later-pick" data-pop onClick={(e) => e.stopPropagation()}>
                    {/*
                      Два способа и всё.

                      Готовые варианты («через час», «завтра утром») убраны по просьбе
                      заказчика: они угадывают за человека, а он обычно знает точное
                      время — за полчаса до планёрки, в девять утра каждый день.
                    */}
                    <span className="later-mode">
                      <button
                        className={`view-btn${laterRepeat === 'none' ? ' active' : ''}`}
                        onClick={() => setLaterRepeat('none')}
                      >
                        Один раз
                      </button>
                      <button
                        className={`view-btn${laterRepeat === 'daily' ? ' active' : ''}`}
                        onClick={() => setLaterRepeat('daily')}
                      >
                        Каждый день
                      </button>
                    </span>

                    {laterRepeat === 'none' ? (
                      <label className="chat-later-own">
                        <span className="dim">Дата и время</span>
                        <input
                          type="datetime-local"
                          className="input"
                          value={laterAt}
                          onChange={(e) => setLaterAt(e.target.value)}
                        />
                      </label>
                    ) : (
                      <label className="chat-later-own">
                        <span className="dim">Время — каждый день</span>
                        <input
                          type="time"
                          className="input"
                          value={laterTime}
                          onChange={(e) => setLaterTime(e.target.value)}
                        />
                      </label>
                    )}

                    <span className="later-actions">
                      <button className="btn btn-primary btn-sm" onClick={confirmLater}>Отложить</button>
                      <button className="chat-thread-link chat-thread-new" onClick={() => setLaterOpen(false)}>Отмена</button>
                    </span>
                  </span>
                )}
              </span>
              </span>
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
      {infoOpen && active && !thread && (
        <ChatInfoPanel
          chatId={String(active.id)}
          meId={String(user?.id ?? '')}
          users={users}
          onClose={() => setInfoOpen(false)}
          onJumpTo={(messageId) => void openFound({ chatId: String(active.id), messageId, threadRootId: null })}
          onWriteTo={(userId) => void writeTo(userId)}
          canCall={!inCall}
          onCall={(memberIds) => onCall({ id: String(active.id), title: active.title ?? 'Созвон', memberIds, projectId: active.projectId })}
          onMention={(name) => setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${name} `)}
          onChanged={reload}
          onLeft={() => { setInfoOpen(false); setActiveId(null); setMessages([]); reload(); }}
          onTasksOf={(userId) => {
            navigate({ section: 'tasks', view: 'all' });
            // реестр слушает и ставит фильтр по исполнителю
            window.dispatchEvent(new CustomEvent('teamcrm:tasks-of', { detail: { userId } }));
          }}
          onCalendar={() => navigate({ section: 'calendar' })}
        />
      )}
      {thread && (
        <section className="chat-thread">
          <div className="chat-head">
            <span><Icon name="chat" size={15} /> <b>Ветка обсуждения</b></span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setThread(null); clearThreadPending(); }}
              title="Закрыть ветку"
              aria-label="Закрыть ветку"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="chat-feed" onScroll={closePops}>
            {thread.messages.map((m, i) => (
              <div key={m.id} className={i === 0 ? 'thread-root' : ''}>
                <div className="chat-line">
                  <div
                    className={`chat-msg${ctxFor?.id === String(m.id) ? ' msg-ctx-open' : ''}`}
                    {...messageMenuProps(m)}
                  >
                    <div className="chat-author">{m.author_name}</div>
                    {/* Ссылки кликаются и здесь: ветка — такая же переписка. */}
                    {m.body && editing !== String(m.id) && <MessageText text={m.body} className="chat-body" />}
                    {/*
                      Правка своего сообщения — и в ветке тоже.

                      Пункт «Изменить» в меню был, а поля правки здесь не было:
                      человек нажимал и не получал ничего. Разметка та же, что в
                      ленте: Enter сохраняет, Esc отменяет.
                    */}
                    {editing === String(m.id) && (
                      <div
                        className="chat-edit"
                        onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) setEditing(null); }}
                      >
                        {/* Правим тем же полем, что и пишем: «@» должно работать и здесь. */}
                        <MentionField
                          value={editText}
                          users={mentionUsers}
                          onChange={setEditText}
                          onMention={(userId) => {
                            if (userId === 'ai') return;
                            setMentioned((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
                          }}
                          rows={2}
                          autoGrow
                          onEnter={() => { void saveEdit(String(m.id)); }}
                        />
                        <div className="chat-edit-actions">
                          <button className="btn btn-primary btn-sm" onClick={() => saveEdit(String(m.id))}>Сохранить</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Отмена</button>
                        </div>
                      </div>
                    )}
                    {(m.files?.length ? m.files : m.file_id ? [{ fileId: String(m.file_id), name: m.file_name ?? 'файл' }] : []).map((f) => (
                      <ChatAttachment
                        key={f.fileId}
                        fileId={f.fileId}
                        fileName={f.name ?? 'файл'}
                        onOpen={(url, name, mime) => setPreview({ url, name, mime })}
                      />
                    ))}
                  </div>
                  {/* Поставленные реакции — как в ленте: ответить «понял» можно и в ветке. */}
                  {(m.reactions ?? []).length > 0 && (
                    <div className="chat-reactions">
                      {(m.reactions ?? []).map((r) => (
                        <button
                          key={r.emoji}
                          className={r.mine ? 'reaction mine' : 'reaction'}
                          onClick={() => react(String(m.id), r.emoji)}
                          title={r.mine ? 'Снять свою реакцию' : 'Поддержать'}
                        >
                          {r.emoji} {r.count}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="chat-under">
                    <span className="chat-time" title={new Date(m.created_at).toLocaleString('ru-RU')}>{stampLabel(m.created_at)}</span>
                    {m.edited_at && <span className="dim chat-under-mark" title="Сообщение изменено">изменено</span>}
                    {/* Полный набор действий, тот же, что в ленте: реакция, правка,
                        удаление, напоминание, задача из сообщения. */}

                  </div>
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
            {/* Приготовленные вложения ветки: видно, что уйдёт, и можно убрать лишнее. */}
            {threadPending.length > 0 && (
              <div className="chat-pending">
                {threadPending.map((p, i) => (
                  <span key={`${p.file.name}-${i}`} className="chat-pending-item">
                    {p.url
                      ? <img className="chat-pending-img" src={p.url} alt={p.file.name} />
                      : <Icon name="paperclip" size={16} />}
                    <span className="chat-pending-name">{p.file.name}</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => dropThreadPending(i)}
                      title="Убрать это вложение"
                      aria-label="Убрать вложение"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* Скрепка и в ветке: показать снимком быстрее, чем описать словами. */}
            <label className="btn btn-ghost btn-sm" title="Приложить файлы" style={{ cursor: 'pointer' }}>
              <Icon name="paperclip" size={16} />
              <input
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  if (list.length) attachToThread(list);
                  e.currentTarget.value = '';
                }}
              />
            </label>
            <input
              className="input"
              placeholder="Ответить в ветке… Ctrl+V вставит картинку"
              value={threadBody}
              onChange={(e) => setThreadBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToThread(); } }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={sendToThread}
              disabled={!threadBody.trim() && !threadPending.length}
              title="Ответить"
            >
              <Icon name="send" />
            </button>
          </div>
        </section>
      )}

      {toTask && activeId && (
        <MessageToTask
          chatId={activeId}
          messageId={String(toTask.id)}
          messageText={String(toTask.body || toTask.file_name || '')}
          onClose={() => setToTask(null)}
          onCreated={(taskId, title, projectId) => {
            setMessages((prev) => prev.map((m) => (String(m.id) === String(toTask.id)
              ? { ...m, task_id: taskId, task_title: title, task_project_id: projectId } : m)));
            setToTask(null);
            showToast({ title: 'Задача создана', body: title, section: 'chat' });
          }}
        />
      )}

      {/*
        Отложенные сообщения — отдельным окном, как в Telegram.

        Показываем их так же, как в переписке: пузырь с текстом и временем. Над
        каждым три действия — отправить сейчас, перенести, удалить. Без такого окна
        отложенное было чёрным ящиком: непонятно, что в нём и как это изменить.
      */}
      {queueOpen && (
        <div className="modal-overlay" {...overlayProps(() => setQueueOpen(false))}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3><Icon name="clock" size={16} /> Отложенные сообщения</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setQueueOpen(false)} title="Закрыть" aria-label="Закрыть">
                <Icon name="close" size={16} />
              </button>
            </div>
            {scheduled.length === 0 && <div className="dim">Здесь пусто — отложенных сообщений нет.</div>}
            {scheduled.map((x) => (
              <div key={x.id} className="later-item">
                <div className="later-when">
                  <Icon name={x.repeat === 'daily' ? 'refresh' : 'clock'} size={13} /> Отправлю {laterLabel(x)}
                  {x.sentCount > 0 && (
                    <span className="dim"> · уже отправлено раз: {x.sentCount}</span>
                  )}
                </div>
                <div className="chat-body later-text">{x.body}</div>
                <div className="later-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => sendScheduledNow(x.id)}>
                    <Icon name="send" size={13} /> Отправить сейчас
                  </button>
                  <label className="btn btn-ghost btn-sm later-time" title="Перенести на другое время">
                    <Icon name="calendar" size={13} /> Перенести
                    <input
                      type="datetime-local"
                      onChange={(e) => {
                        const at = new Date(e.target.value);
                        if (!Number.isNaN(at.getTime())) void rescheduleAt(x.id, at);
                      }}
                    />
                  </label>
                  <button className="btn btn-ghost btn-sm btn-delete" onClick={() => cancelScheduled(x.id)}>
                    <Icon name="trash" size={13} /> Удалить
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}


      {channelOpen && (
        <ChannelModal
          meId={user?.id}
          onClose={() => setChannelOpen(false)}
          onCreated={async (chatId) => {
            setChannelOpen(false);
            await reload();
            setView('chat');
            openChat(chatId);
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

function ChatRow({ chat, active, group, onClick, onStar }: {
  chat: Chat; active: boolean; group?: string; onClick: () => void;
  /** Закрепить сверху. В списке из сорока переписок нужные четыре ищут глазами. */
  onStar?: () => void;
}) {
  const icon = chat.kind === 'dm' ? (chat.title?.[0]?.toUpperCase() ?? '?') : '#';
  return (
    <div className={`chat-row-wrap${active ? ' active' : ''}`}>
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
    {/* Звезда вынесена из кнопки чата: кнопку внутрь кнопки не вложить, а закреплять
        нужно, не открывая переписку. */}
    {onStar && (
      <button
        className={`chat-star${chat.favorite ? ' on' : ''}`}
        onClick={onStar}
        title={chat.favorite ? 'Убрать из избранного' : 'Закрепить сверху'}
        aria-label={chat.favorite ? 'Убрать из избранного' : 'Закрепить сверху'}
      >
        <Icon name="star" size={13} />
      </button>
    )}
    </div>
  );
}
