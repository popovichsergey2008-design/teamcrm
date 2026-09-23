import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { MentionField } from './MentionField';
import { VoiceStatus } from './VoiceStatus';
import { ChatAttachment } from './ChatAttachment';
import { Lightbox, LightboxItem } from './Lightbox';
import { api, ApiError, QUEUED } from '../lib/api';
import { OFFLINE_FLUSHED_EVENT, useQueuedFor } from '../hooks/useOfflineQueue';
import { SYNC_EVENT, syncTouches, type SyncDetail } from '../hooks/useDeltaSync';
import { dayLabel, plural, sameGroup, stampLabel } from '../lib/chat-text';
import { MessageText } from './MessageText';
import { longPressProps, MenuAt, MessageMenu } from './MessageMenu';
import { pasteBelongsHere } from '../lib/paste-scope';
import { useDismiss } from '../hooks/useDismiss';
import { selectionIn } from '../lib/selection';
import { shrinkImage } from '../lib/image-shrink';
import { humanSize, isAnonymousClipboardName, isImageName, screenshotName } from '../lib/attachments';
import { orderMentions } from '../lib/task-mentions';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { clearDraft, readDraft, writeDraft } from '../lib/chat-drafts';
import { useAuth } from '../state/auth';
import { getSocket } from '../lib/socket';
import { requestCall } from '../lib/notifications';

/**
 * Цвет имени автора.
 *
 * Считается из id, поэтому за человеком закреплён навсегда и совпадает у всех, кто
 * читает переписку. Шесть оттенков: каждый проверен на контраст в обеих темах
 * (`npm run contrast`), а больше глаз в ленте всё равно не различает.
 */
function whoColor(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return (h % 6) + 1;
}

/** Реакции: ответить «ок» знаком, не засоряя обсуждение и не будя участников. */
const REACTIONS = ['👍', '❤️', '🔥', '👏', '😁', '🤔'];

/**
 * Помощник в списке упоминаний.
 *
 * Зовут его так же, как коллегу, — через «@». Отдельная кнопка делала из ИИ
 * инструмент в стороне от разговора, хотя он участник этого разговора.
 */
const AI_MENTION_ID = 'ai';
const AI_MENTION_NAME = 'AnthillBot';
/**
 * «@AnthillBot», «@AI», «@бот» — человек пишет как придётся, и старые написания
 * обязаны работать: они уже в чужой переписке и в чужих привычках.
 *
 * ГРАБЛИ: `\\b` и `\\w` не видят кириллицу, из-за чего «@ии» не срабатывало
 * вовсе — границу слова проверяем явным классом.
 */
const MENTIONS_AI = /@(anthillbot|ai|ии|ai-помощник|бот)(?![\wа-яё-])/gi;

/** Частые вопросы помощнику — чтобы не формулировать заново то, что спрашивают всегда. */
const QUICK_ASKS: { label: string; ask: string }[] = [
  { label: 'Объяснить задачу', ask: 'Объясни коротко и простыми словами, что от меня требуется по этой задаче.' },
  { label: 'Составить план', ask: 'Предложи порядок действий по этой задаче.' },
  { label: 'Что осталось', ask: 'Что по этой задаче ещё не сделано? Сверься с чек-листом и обсуждением.' },
  { label: 'Резюме обсуждения', ask: 'Кратко подведи итог обсуждения: что решили, что изменилось, какие вопросы открыты.' },
  { label: 'Отчёт постановщику', ask: 'Подготовь короткий отчёт о проделанной работе для постановщика.' },
];

/** Событие истории по-русски: строка вида «participant_added» человеку ничего не говорит. */
const ACTIVITY_LABEL: Record<string, string> = {
  created: 'создал задачу',
  updated: 'изменил поля',
  moved: 'перенёс',
  commented: 'написал сообщение',
  attached: 'приложил файл',
  checklist: 'правил чек-лист',
  label: 'менял метки',
  handoff_forced: 'сдал работу без полной готовности',
  participant_added: 'добавил участника',
  participant_removed: 'убрал участника',
  approval_requested: 'сдал работу на согласование',
  deadline_shift_asked: 'отчитался «Сделал» и просит перенести срок',
  deadline_shifted: 'перенёс срок',
  deadline_shift_declined: 'отказал в переносе срока',
  approval_confirmed: 'принял работу',
  approval_returned: 'вернул на доработку',
  approval_setting: 'изменил правило согласования',
  merged_in: 'объединил сюда другую задачу',
  merged_into: 'объединил эту задачу с другой',
};

function activityText(a: { kind: string; detail?: Record<string, any> }): string {
  const label = ACTIVITY_LABEL[a.kind] ?? a.kind;
  if (a.kind === 'moved' && a.detail?.to) return `${label} в «${a.detail.to}»`;
  if (a.kind === 'approval_returned' && a.detail?.reason) return `${label}: ${a.detail.reason}`;
  // Номер обязателен: «объединил» без номера не отвечает на вопрос «с чем».
  if ((a.kind === 'merged_in' || a.kind === 'merged_into') && a.detail?.taskId) {
    return `${label} #${a.detail.taskId}${a.detail.title ? ` «${a.detail.title}»` : ''}`;
  }
  // обход приёмки без списка нехваток бесполезен: ради этого списка запись и делается
  if (a.kind === 'handoff_forced' && Array.isArray(a.detail?.missing)) {
    return `${label}: ${a.detail.missing.join('; ')}`;
  }
  return label;
}

const initials = (name: string) => (name?.trim()?.[0] ?? '?').toUpperCase();

/**
 * Чат задачи: разговор команды и помощник, который знает эту задачу.
 *
 * Устроен как переписка, а не как список комментариев: сообщения одного человека
 * подряд склеиваются, дни разделены, картинки видны сразу, ответить можно на
 * выделенный кусок. Разница не косметическая — по задаче спорят, договариваются и
 * возвращаются к сказанному через неделю, и «кто, когда и о чём» должно читаться
 * взглядом, а не восстанавливаться по датам.
 *
 * История задачи внизу — не украшение: строка «написал сообщение» ведёт к самому
 * сообщению. Без этого история отсылает в никуда.
 */
export function TaskChat({
  taskId, assigneeId, creatorId, participants = [], onRefresh,
  wide = false, title, status, projectId, onExpand, onCollapse,
}: {
  taskId: string;
  /** Кто в этой задаче кто — от этого зависит порядок подсказки при «@». */
  assigneeId?: string | null;
  creatorId?: string | null;
  participants?: { user_id: string; role: string }[];
  onRefresh: () => void;
  /**
   * Разговор во всю ширину карточки (вкладка «Чат»).
   *
   * В узкой колонке справа абзац из пяти строк превращается в двадцать — на это и
   * жаловались. Компонент один и тот же: расходятся только ширина и шапка, а вся
   * механика (ответы, реакции, поиск, ИИ) остаётся общей и не разъезжается.
   */
  wide?: boolean;
  /** Проект задачи: комната созвона знает его, и задачи из разбора лягут в нужную доску. */
  projectId?: string | null;
  /** Название задачи и колонка — подпись в шапке: о чём разговор и на каком этапе. */
  title?: string;
  status?: string | null;
  /** Развернуть из колонки во вкладку и обратно. */
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const { user } = useAuth();
  const [comments, setComments] = useState<any[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);
  const [body, setBody] = useState(() => readDraft(`task:${taskId}`));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** Поиск по обсуждению: в переписке на сотню сообщений нужное иначе не найти. */
  const [query, setQuery] = useState('');
  /** Поиск прячется за лупой в шапке: над лентой он отнимает место у разговора. */
  const [searchOpen, setSearchOpen] = useState(false);

  /** Правка своего сообщения: сказанное вслух не переписывают, написанное — да. */
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  // Черновик обсуждения задачи — локально и по задаче (ТЗ-9): закрыл карточку, открыл — текст на месте.
  useEffect(() => { if (!editing) writeDraft(`task:${taskId}`, body); }, [taskId, body, editing]); // правка сообщения — не черновик
  /**
   * Ответ на сообщение В ЛЕНТЕ — как в Telegram.
   *
   * Живёт отдельно от веток и не отменяет их. Разница проста и объяснима на пальцах:
   * обычный ответ остаётся в общем разговоре и цитирует одну реплику, ветка уводит
   * обсуждение в сторону и не засоряет ленту. Заказчик просил и то, и другое.
   */
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; excerpt: string } | null>(null);
  /** Файл, выбранный или вставленный, но ещё не отправленный. */
  /** Вложения, ожидающие отправки. Список, а не один файл: снимков прикладывают по нескольку. */
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  /** Записанное голосовое: его сначала слушают, а потом отправляют или стирают. */
  const [note, setNote] = useState<{ blob: Blob; url: string } | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  /** Кто докуда дочитал: из этого собирается строка «Просмотрено» под своим сообщением. */
  const [readers, setReaders] = useState<{ userId: string; name: string; lastReadId: string }[]>([]);
  /** Уже поднимаем старое — второй раз на ту же прокрутку не идём. */
  const [olderBusy, setOlderBusy] = useState(false);
  /**
   * Открытая ветка (ТЗ-7, разд. 7).
   *
   * Разворачивается прямо под корневым сообщением, а не второй колонкой: в карточке
   * задачи колонок и так две, третья превратила бы разговор в щель. Свернули —
   * вернулись в ленту, ничего не потеряв.
   */
  const [thread, setThread] = useState<{ rootId: string; replies: any[] } | null>(null);
  /** Ссылка на открытую ветку: обработчик сокета вешается один раз и замыкание устареет. */
  const threadRef = useRef<{ rootId: string } | null>(null);
  const [threadBody, setThreadBody] = useState('');
  /** Выделенный кусок, на который отвечают: уедет цитатой вместе с ответом. */
  const [threadQuote, setThreadQuote] = useState<{ author: string; excerpt: string } | null>(null);
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  /** Показывать ли список закреплённых: обычно он свёрнут в одну строку. */
  const [pinsOpen, setPinsOpen] = useState(false);
  /** Панели шапки: участники, история, выбор способа звонка. Открыта всегда одна. */
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  /** Смайлы и быстрые вопросы к ИИ — прячутся в поле ввода, как в мессенджере. */
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  /** Куда прокрутили из истории — подсвечиваем, иначе непонятно, что именно нашли. */
  const [highlight, setHighlight] = useState<string | null>(null);
  /** Процитированный кусок внутри найденного сообщения — подсвечен отдельно (задача #1338). */
  const [quoteMark, setQuoteMark] = useState<{ id: string; text: string } | null>(null);
  /** У какого сообщения открыт выбор реакции: набор из шести эмодзи в каждой строке — мусор. */
  /**
   * Меню сообщения по правой кнопке — как в Telegram.
   *
   * Одно на всю ленту: у какого сообщения открыто и в какой точке экрана. Раньше под
   * каждой репликой стояли «Ответить», «В ветку», смайл и троеточие — заказчик
   * попросил убрать их и сделать «один в один как в телеграме».
   */
  const [ctxFor, setCtxFor] = useState<{ id: string; at: MenuAt; picked: string } | null>(null);
  const [allHistory, setAllHistory] = useState(false);
  /**
   * Просмотр вложений — галереей по всему обсуждению (как в мессенджерах).
   * Открыли один снимок — остальные листаются стрелками и смахиванием.
   */
  const [preview, setPreview] = useState<{ items: LightboxItem[]; index: number } | null>(null);

  /** Картинки обсуждения по порядку: документы в галерею не берём, их скачивают. */
  const galleryItems = (): LightboxItem[] => comments.flatMap((c: any) => {
    const files = c.files?.length ? c.files : (c.file_id ? [{ fileId: String(c.file_id), name: c.file_name }] : []);
    return files
      .filter((f: any) => String(f.mime ?? '').startsWith('image/') || isImageName(String(f.name ?? '')))
      .map((f: any) => ({ fileId: String(f.fileId), name: String(f.name ?? 'файл'), mime: f.mime }));
  });

  const openPreview = (fileId: string) => {
    const items = galleryItems();
    const index = Math.max(0, items.findIndex((x) => x.fileId === String(fileId)));
    setPreview(items.length ? { items, index } : { items: [{ fileId, name: 'файл' }], index: 0 });
  };
  const [advice, setAdvice] = useState<{
    answer: string; checklist: string[]; suggestion: { field: string; value: string; label: string } | null;
  } | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  /** Поле ввода: к нему прокручиваем, когда прокручивается вся колонка целиком. */
  const composeRef = useRef<HTMLDivElement | null>(null);
  /**
   * Человек читает старое, а не хвост.
   *
   * Тогда лента не прыгает вниз от каждого нового сообщения — это худшее, что может
   * сделать чат с тем, кто как раз перечитывает вчерашнюю договорённость. Вместо
   * прыжка внизу появляется «↓ N новых».
   */
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [unseen, setUnseen] = useState(0);
  /** Сколько сообщений было в прошлый раз — по этому и считаем «новое». */
  const countRef = useRef(0);
  /** Кто сейчас набирает: имя живёт три секунды и продлевается каждым событием. */
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  /** Отправляемое сообщение — на экране сразу, с пометкой «отправляется». */
  const [sending, setSending] = useState<{ body: string; at: string } | null>(null);
  /** Сообщения, написанные без сети: лежат в очереди и показываются на месте (волна 9). */
  const queued = useQueuedFor(`/tasks/${taskId}/comments`);
  /** Когда последний раз сказали «печатаю»: чаще раза в две секунды незачем. */
  const typingSentAt = useRef(0);

  /**
   * Загружена ли переписка целиком.
   *
   * Карточка открывается с хвостом в сто сообщений: у импортированной задачи их
   * бывают сотни, и рисовать всё разом — это пауза при открытии ради того, что
   * человек не читает. Кнопка сверху поднимает остальное.
   */
  const [fullyLoaded, setFullyLoaded] = useState(false);

  const reload = (all = false) => {
    api.listComments(taskId, all)
      .then((rows) => {
        setComments(rows);
        // «Всё загружено» решаем по факту: пришло меньше предела — выше ничего нет
        if (all || rows.length < 100) setFullyLoaded(true);
        setOlderBusy(false);
      })
      .catch(() => undefined);
    api.taskActivity(taskId).then(setActivity).catch(() => undefined);
    api.taskChatReaders(taskId).then(setReaders).catch(() => undefined);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [taskId]);

  /*
    «Просмотрено» — отметка о прочтении.

    Ставим, когда человек ОТКРЫЛ разговор и стоит внизу ленты: он видит последние
    сообщения. Поднятая кнопкой «показать предыдущие» страница прочтением не
    считается — там человек ищет старое, а не читает новое.

    Отметка только ползёт вверх (это же правило и на сервере), поэтому прокрутка
    назад не снимает у автора уже показанное подтверждение.
  */
  const lastId = comments.length ? String(comments[comments.length - 1].id) : '';
  useEffect(() => {
    if (!lastId || !atBottom) return;
    api.markTaskChatRead(taskId, lastId)
      .then(() => api.taskChatReaders(taskId).then(setReaders))
      .catch(() => undefined);
  }, [taskId, lastId, atBottom]);

  /*
    Чужую отметку показываем сразу: «ты видел?» — половина вопросов в задачах.
  */
  useEffect(() => {
    const socket = getSocket();
    const onRead = (p: { taskId?: string }) => {
      if (String(p?.taskId ?? '') !== String(taskId)) return;
      api.taskChatReaders(taskId).then(setReaders).catch(() => undefined);
    };
    socket.on('task.comment_read', onRead);
    return () => { socket.off('task.comment_read', onRead); };
  }, [taskId]);

  /*
    Открыли задачу — видно КОНЕЦ разговора и поле ввода.

    Так устроен любой мессенджер: разговор читают с последней реплики, а не с той,
    что была полгода назад. Ссылки на ТЗ и статьи, которые кладут последними,
    оказывались за экраном — до них надо было прокручивать.

    Дважды: сразу после отрисовки и ещё раз через мгновение — картинки и вложения
    занимают высоту не мгновенно, и без второго прохода лента останавливается
    чуть выше конца.
  */
  useEffect(() => {
    if (!comments.length) return;
    const first = requestAnimationFrame(() => toBottom());
    const second = window.setTimeout(() => toBottom(), 250);
    return () => { cancelAnimationFrame(first); window.clearTimeout(second); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, wide, comments.length > 0]);
  /*
    Живое обсуждение задачи.

    Раньше карточка не слушала сокет вовсе: коллега писал в обсуждении, а увидеть это
    можно было только перезагрузкой страницы или переоткрытием задачи. В чатах так
    давно не работает — в задачах должно быть так же.

    Перечитываем пачкой: на бурное обсуждение прилетает десяток событий подряд, и
    десять запросов подряд ради одного и того же списка не нужны. Своё сообщение
    уже на экране — перечитывание его не двоит, список приходит с сервера целиком.
  */
  useEffect(() => {
    const socket = getSocket();
    let timer: number | null = null;
    const soon = (p: { taskId?: string }) => {
      if (String(p?.taskId ?? '') !== String(taskId)) return;
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        reload(fullyLoaded);
        // Открытая ветка — тоже часть экрана: без этого чужой ответ в ней виден
        // только после повторного открытия, а счётчик уже вырос.
        const open = threadRef.current;
        if (open) void openThread(open.rootId);
      }, 350);
    };
    for (const ev of ['task.comment_added', 'task.attachment_added', 'task.comment_deleted']) socket.on(ev, soon);
    // «Глеб печатает…»: своё игнорируем — человеку незачем видеть самого себя
    const onTyping = (p: { taskId?: string; userId?: string; name?: string }) => {
      if (String(p?.taskId ?? '') !== String(taskId)) return;
      if (String(p?.userId ?? '') === String(user?.id ?? '')) return;
      setTyping((prev) => ({ ...prev, [String(p.userId)]: { name: p.name ?? 'Коллега', until: Date.now() + 3000 } }));
    };
    socket.on('task.typing', onTyping);
    // связь моргнула — догоняем пропущенное, иначе обсуждение застынет на моменте обрыва
    const onReconnect = () => reload(fullyLoaded);
    socket.on('connect', onReconnect);
    return () => {
      for (const ev of ['task.comment_added', 'task.attachment_added', 'task.comment_deleted']) socket.off(ev, soon);
      socket.off('task.typing', onTyping);
      socket.off('connect', onReconnect);
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, fullyLoaded, user?.id]);

  /* Надпись гаснет сама: обещание «через три секунды» должен сдерживать таймер,
     а не следующее событие — иначе «печатает…» висит после того, как человек ушёл. */
  useEffect(() => {
    if (!Object.keys(typing).length) return;
    const t = window.setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(prev).filter(([, v]) => v.until > now));
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [typing]);

  // Отчёт проверки ИИ ложится в переписку с сервера — обсуждение обязано его показать
  // сразу, а не после переоткрытия карточки.
  useEffect(() => {
    const onExternal = (e: Event) => {
      const id = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (!id || String(id) === String(taskId)) reload();
    };
    window.addEventListener('teamcrm:task-chat-reload', onExternal);
    // Догнали пропущенное после разрыва или ушла офлайн-очередь — перечитать, если касается нас.
    const onSync = (e: Event) => {
      if (syncTouches((e as CustomEvent<SyncDetail>).detail, { type: ['task_comment', 'checklist_item'], parentId: taskId })) reload();
    };
    const onFlushed = () => reload();
    window.addEventListener(SYNC_EVENT, onSync);
    window.addEventListener(OFFLINE_FLUSHED_EVENT, onFlushed);
    return () => {
      window.removeEventListener('teamcrm:task-chat-reload', onExternal);
      window.removeEventListener(SYNC_EVENT, onSync);
      window.removeEventListener(OFFLINE_FLUSHED_EVENT, onFlushed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  useEffect(() => {
    api.listUsers()
      .then((team: any[]) => setUsers(team.map((u) => ({ id: String(u.id), fullName: u.fullName }))))
      .catch(() => undefined);
  }, []);

  /**
   * Скриншот из буфера — как в мессенджерах: Ctrl+V, и он в обсуждении.
   *
   * Слушаем окно, пока карточка открыта: человек снимает экран, возвращается в задачу
   * и жмёт вставку, не целясь в поле ввода. Текстовую вставку это не задевает —
   * реагируем, только если в буфере действительно файл-картинка.
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      // Поверх карточки открыли окно — снимок нужен ему (задача #1367).
      if (!pasteBelongsHere(composeRef.current)) return;
      e.preventDefault();
      void attach(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  /**
   * Список для «@»: сначала помощник, потом те, кто в этой задаче участвует.
   *
   * Общий алфавитный перечень сотрудников почти бесполезен — зовут не «кого-нибудь
   * из компании», а участников задачи. Порядок зависит от того, кто пишет: исполнителю
   * первым нужен постановщик, постановщику — исполнитель.
   */
  const mentionUsers = orderMentions(
    [{ id: AI_MENTION_ID, fullName: AI_MENTION_NAME, hint: 'знает эту задачу' }, ...users],
    { meId: String(user?.id ?? ''), assigneeId, creatorId, participants },
    AI_MENTION_ID,
  );

  /** Как зовут меня — для строки «отправляется»: она выглядит как обычное сообщение. */
  const meName = users.find((u) => String(u.id) === String(user?.id ?? ''))?.fullName ?? 'Вы';

  /** Сказать остальным, что набираю. Не чаще раза в две секунды: это состояние, а не поток. */
  const pingTyping = () => {
    const now = Date.now();
    if (now - typingSentAt.current < 2000) return;
    typingSentAt.current = now;
    getSocket().emit('task.typing', { taskId });
  };

  /** Скриншот приходит без имени — даём ему дату, иначе в файлах десяток «image.png». */
  /*
    Снимок ужимаем ЗДЕСЬ, при выборе, а не при отправке.

    Заказчик: «секунд тридцать не мог отправить сообщение — видимо, фото грузилось».
    Фотография с телефона весит мегабайты и уходит полминуты. Пока человек пишет
    подпись, снимок уже пережат, и отправка занимает секунду.
  */
  const attach = async (files: File | File[]) => {
    const list = Array.isArray(files) ? files : [files];
    const prepared = await Promise.all(list.map(async (file) => {
      const small = await shrinkImage(file);
      const named = isAnonymousClipboardName(small.name) && small.type.startsWith('image/')
        ? new File([small], screenshotName(new Date(), small.type), { type: small.type })
        : small;
      return { file: named, url: isImageName(named.name) ? URL.createObjectURL(named) : '' };
    }));
    // Десять — предел одного сообщения: дальше это уже архив, а не обсуждение.
    setPending((prev) => [...prev, ...prepared].slice(0, 10));
  };

  /** Убрать одно вложение: приложил лишнее — не отправлять же всё заново. */
  const dropPending = (idx: number) => setPending((prev) => {
    const out = prev.filter((_, i) => i !== idx);
    const gone = prev[idx];
    if (gone?.url) URL.revokeObjectURL(gone.url);
    return out;
  });
  const clearPending = () => setPending((prev) => {
    for (const p of prev) if (p.url) URL.revokeObjectURL(p.url);
    return [];
  });

  const ask = async (question: string) => {
    if (!question.trim()) return;
    setBusy(true); setErr(''); setAdvice(null);
    try {
      const res = await api.askTaskAssistant(taskId, question.trim());
      setAdvice(res);
      setBody('');
      reload(); // ответ лёг в ленту обсуждения — он часть истории задачи
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Помощник не ответил'); }
    finally { setBusy(false); }
  };

  const send = async () => {
    const text = body.trim();
    if (!text && !pending.length) return;
    // Помощника зовут упоминанием, как коллегу: «@AI-помощник, что тут по срокам».
    // Ищем в любом месте строки: в живой переписке обращение идёт после слов
    // «Борис, глянь, и @AI тоже».
    if (!pending.length && MENTIONS_AI.test(text)) return ask(text.replace(MENTIONS_AI, ' ').trim() || text);
    setBusy(true);
    try {
      if (editing) {
        await api.editComment(taskId, editing.id, text);
        setEditing(null);
      } else if (pending.length) {
        await api.addCommentFile(taskId, pending.map((p) => p.file), text, replyTo?.id, replyTo?.excerpt);
        clearPending();
      } else {
        /*
          Своё сообщение показываем СРАЗУ, с пометкой «отправляется».

          Ожидание ответа сервера — полсекунды, но в эти полсекунды поле уже пустое,
          а сообщения ещё нет: человек не понимает, ушло ли оно, и жмёт «Отправить»
          второй раз. Пришёл ответ — временная строка сменяется настоящей.
        */
        setSending({ body: text, at: new Date().toISOString() });
        // replyToId без threadRootId — это ответ В ЛЕНТЕ: цитата есть, ветки нет
        await api.addComment(taskId, text, undefined, replyTo?.id, replyTo?.excerpt);
      }
      setReplyTo(null);
      setBody(''); clearDraft(`task:${taskId}`); reload(); onRefresh();
    } catch (e) {
      // Сети нет — сообщение легло в очередь и показано в ленте: это не ошибка, поле можно очистить.
      if (e instanceof ApiError && e.code === QUEUED) { setReplyTo(null); setBody(''); clearDraft(`task:${taskId}`); }
      else setErr(e instanceof ApiError ? e.message : 'Не отправилось');
    }
    finally { setBusy(false); setSending(null); }
  };

  const openThread = async (rootId: string) => {
    try {
      const t = await api.taskThread(taskId, rootId);
      setThread(t);
      threadRef.current = { rootId: t.rootId };
      setThreadBody(''); setAlsoInChannel(false);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть ветку'); }
  };

  const sendToThread = async () => {
    const text = threadBody.trim();
    if (!text || !thread) return;
    setBusy(true); setErr('');
    /*
      Свой ответ показываем СРАЗУ, не дожидаясь сервера.

      Секунда ожидания в ветке заметнее, чем в ленте: человек смотрит в одну точку
      под сообщением и не понимает, ушёл ответ или нет. Настоящий ответ придёт с
      перечитыванием ветки и заменит временный.
    */
    const optimistic = {
      id: `tmp-${Date.now()}`, author_name: meName, body: text,
      created_at: new Date().toISOString(), pending: true,
    };
    setThread((prev) => (prev ? { ...prev, replies: [...prev.replies, optimistic] } : prev));
    setThreadBody('');
    try {
      await api.addComment(taskId, text, undefined, threadQuote ? thread.rootId : undefined, threadQuote?.excerpt, {
        rootId: thread.rootId, alsoInChannel,
      });
      setThreadQuote(null);
      // ветку перечитываем целиком: свой ответ должен встать на своё место по времени
      await openThread(thread.rootId);
      reload(fullyLoaded); onRefresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Ответ не отправился');
      setThread((prev) => (prev ? { ...prev, replies: prev.replies.filter((x: any) => x.id !== optimistic.id) } : prev));
      setThreadBody(text);
    }
    finally { setBusy(false); }
  };

  /** Закрепить или открепить. Список закреплённых живёт прямо в ленте — она источник правды. */
  const togglePin = async (id: string, pinned: boolean) => {
    setErr('');
    try { await api.pinComment(taskId, id, pinned); reload(fullyLoaded); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
  };

  const dropNote = () => setNote((prev) => {
    if (prev?.url) URL.revokeObjectURL(prev.url);
    return null;
  });

  /**
   * Отправить голосовое.
   *
   * Сначала расшифровываем, потом отправляем одним сообщением: текст идёт подписью к
   * аудио. Расшифровка не удалась (нет ключа, тишина в записи) — отправляем как есть:
   * потерять голосовое из-за необязательной подписи было бы странно.
   */
  const sendNote = async () => {
    if (!note) return;
    setNoteBusy(true); setErr('');
    try {
      const stamp = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const file = new File([note.blob], `Голосовое ${stamp}.webm`, { type: note.blob.type || 'audio/webm' });
      let caption = '';
      try { caption = (await api.nlTranscribe(note.blob)).text ?? ''; } catch { caption = ''; }
      await api.addCommentFile(taskId, file, caption);
      dropNote(); reload(); onRefresh();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Голосовое не отправилось'); }
    finally { setNoteBusy(false); }
  };

  /**
   * «В текст»: та же запись, но сообщением уходит расшифровка, а не аудио.
   *
   * Продиктовать формулировку и продиктовать объяснение — разные задачи, и решать за
   * человека, что из этого он сейчас делает, нельзя: голосовое в переписке слушают
   * минуту, текст читают пять секунд.
   */
  const noteToText = async () => {
    if (!note) return;
    setNoteBusy(true); setErr('');
    try {
      const { text } = await api.nlTranscribe(note.blob);
      if (!text) setErr('Речь не распознана. Для голоса нужен ключ OpenAI (Whisper) в «Интеграции → ИИ».');
      else setBody((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
      if (text) dropNote();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось распознать'); }
    finally { setNoteBusy(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить сообщение? Восстановить его будет нельзя.')) return;
    try { await api.deleteComment(taskId, id); reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалилось'); }
  };

  const react = async (id: string, emoji: string) => {
    // Оптимистично: реакция должна ставиться мгновенно, это её единственная ценность.
    setComments((prev) => prev.map((c) => {
      if (String(c.id) !== String(id)) return c;
      const list = [...(c.reactions ?? [])];
      const found = list.find((r: any) => r.emoji === emoji);
      if (found) {
        found.mine ? (found.count -= 1) : (found.count += 1);
        found.mine = !found.mine;
      } else list.push({ emoji, count: 1, mine: true });
      return { ...c, reactions: list.filter((r: any) => r.count > 0) };
    }));
    try { await api.reactToComment(taskId, id, emoji); } catch { reload(); }
  };

  // Голос: продиктовать замечание проще, чем набирать его на телефоне.
  /*
    Голосовое сообщение (ТЗ-7, разд. 13).

    Раньше микрофон сразу превращал речь в текст. Это удобно, когда диктуешь
    формулировку, но не отвечает на «объясни голосом, тут на две минуты»: интонация
    и скорость пропадали. Теперь запись становится сообщением: её слушают.

    Расшифровку всё равно делаем и кладём подписью — голосовое, которое нельзя найти
    поиском и прочитать глазами в переговорке, наполовину бесполезно.
  */
  const voice = useVoiceInput(
    (text) => { setBody((prev) => (prev.trim() ? prev.trim() + ' ' + text : text)); },
    {
      onBlob: (blob) => {
        setNote((prev) => {
          if (prev?.url) URL.revokeObjectURL(prev.url);
          return { blob, url: URL.createObjectURL(blob) };
        });
      },
    },
  );

  /**
   * Ответить — и, если человек выделил кусок, ответить именно на него.
   *
   * В длинном сообщении спорят об одном абзаце, а цитата целиком («да, согласен» под
   * простынёй текста) не отвечает, с чем именно согласны. Выделение берём только внутри
   * этого сообщения: случайный текст со стороны в цитату попасть не должен.
   */
  /**
   * «Ответить» — это ответ ПОД сообщением, а не реплика в конец ленты.
   *
   * Так и жаловались: ответ на сообщение из середины разговора оказывался внизу, и
   * понять, к чему он, было нельзя. Теперь ответ уходит в ветку своего сообщения и
   * виден прямо под ним. Выделенный кусок сохраняется цитатой: в длинном сообщении
   * спорят об одном абзаце.
   */
  /**
   * Выделенный кусок сообщения.
   *
   * Обычно он приходит готовым из меню (там его снимают в момент вызова, пока
   * выделение ещё живо). Аргумент `ready` — этот случай; без него смотрим сами.
   */
  const picked = (node: Element | null, ready?: string) => ready || selectionIn(node);

  /**
   * Ответ в ленте — как в Telegram.
   *
   * Цитата встаёт над полем ввода, а после отправки — шапкой внутри пузыря: видно,
   * на что отвечают, и нажатием можно прыгнуть к исходной реплике. Ветку при этом
   * не заводим: обычный ответ остаётся частью общего разговора.
   */
  const startReply = (c: any, node: Element | null, ready?: string) => {
    const excerpt = picked(node, ready) || String(c.body ?? 'вложение');
    setEditing(null);
    setThread(null);
    setReplyTo({ id: String(c.id), author: c.is_ai ? AI_MENTION_NAME : c.author_name, excerpt });
    composeRef.current?.querySelector('textarea')?.focus();
  };

  /** Ответ ВЕТКОЙ: обсуждение уходит в сторону и общую ленту не засоряет. */
  const startThreadReply = (c: any, node: Element | null, ready?: string) => {
    const excerpt = picked(node, ready);
    setEditing(null);
    setReplyTo(null);
    setThreadQuote(excerpt ? { author: c.is_ai ? AI_MENTION_NAME : c.author_name, excerpt } : null);
    // ответ на ответ уходит в ту же ветку: её корень знает сервер
    void openThread(String(c.thread_root_id ?? c.id));
  };

  /**
   * Переход из истории к самому сообщению.
   *
   * Сообщения может не оказаться на экране: показан хвост переписки, а ссылка ведёт
   * к старому. Тогда сначала поднимаем всю переписку и прыгаем после отрисовки —
   * молча ничего не делать здесь нельзя, кнопка выглядела бы сломанной.
   */
  /** Внизу ли лента. Восемьдесят точек запаса: «почти внизу» — это тоже внизу. */
  const nearBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  /**
   * Кто здесь на самом деле прокручивается.
   *
   * Во всю ширину лента прокручивается сама, а в узкой колонке — вся колонка
   * целиком: под лентой там ещё быстрые вопросы к ИИ и история задачи. Раньше мы
   * всегда двигали ленту, и в колонке это не делало ничего — чат открывался на
   * первом сообщении, а до поля ввода приходилось прокручивать руками.
   */
  const scroller = (): HTMLElement | null => {
    let el: HTMLElement | null = feedRef.current;
    while (el) {
      const st = window.getComputedStyle(el).overflowY;
      if ((st === 'auto' || st === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return feedRef.current;
  };

  const toBottom = (smooth = false) => {
    const el = scroller();
    if (!el) return;
    /*
      Куда именно «вниз».

      Если прокручивается сама лента — до её конца. Если прокручивается колонка
      целиком, её конец — это история задачи, а не разговор: под лентой идут ещё
      быстрые вопросы к ИИ, поле ввода и история. Поэтому целимся в поле ввода:
      над ним видны последние сообщения, а само оно готово принять текст.
    */
    if (el === feedRef.current || !composeRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      composeRef.current.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
    }
    setUnseen(0);
  };

  /**
   * Прокрутка может жить на родителе (узкая колонка) — событие с ленты туда не
   * всплывает. Поэтому слушаем настоящего прокручиваемого, кем бы он ни оказался.
   */
  useEffect(() => {
    const el = scroller();
    if (!el || el === feedRef.current) return;
    const onScroll = () => {
      const bottom = nearBottom(el);
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      if (bottom) setUnseen(0);
      if (el.scrollTop < 60 && !fullyLoaded && !olderBusy) { setOlderBusy(true); reload(true); }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, wide, fullyLoaded, olderBusy, comments.length > 0]);

  /*
    Новые сообщения пришли.

    Внизу — показываем сразу и остаёмся внизу. Выше — ничего не двигаем и копим
    счётчик: человек сам решит, когда спуститься.
  */
  useEffect(() => {
    const before = countRef.current;
    countRef.current = comments.length;
    if (comments.length === before) return;
    if (atBottomRef.current) {
      // после отрисовки: до неё высота ленты ещё прежняя
      requestAnimationFrame(() => toBottom(before > 0));
    } else if (comments.length > before) {
      setUnseen((n) => n + (comments.length - before));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments.length]);

  const goToMessage = async (id: string, excerpt?: string | null) => {
    setQuoteMark(excerpt ? { id, text: excerpt } : null);
    window.setTimeout(() => setQuoteMark((cur) => (cur?.id === id ? null : cur)), 4000);
    let el = feedRef.current?.querySelector(`[data-msg="${id}"]`);
    if (!el && !fullyLoaded) {
      const rows = await api.listComments(taskId, true).catch(() => null);
      if (rows) {
        setComments(rows);
        setFullyLoaded(true);
        await new Promise((r) => window.setTimeout(r, 60)); // ждём отрисовку
        el = feedRef.current?.querySelector(`[data-msg="${id}"]`);
      }
    }
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(String(id));
    window.setTimeout(() => setHighlight(null), 2200);
  };

  const acceptChecklist = async () => {
    if (!advice?.checklist.length) return;
    setBusy(true);
    try { await api.applyAssistantChecklist(taskId, advice.checklist); setAdvice(null); onRefresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не добавилось'); }
    finally { setBusy(false); }
  };

  const q = query.trim().toLowerCase();
  const shown = q ? comments.filter((c) => String(c.body ?? '').toLowerCase().includes(q)) : comments;
  const history = allHistory ? activity : activity.slice(0, 5);

  /*
    Кто в разговоре.

    Участники задачи и есть участники чата: постановщик, исполнитель, соисполнители,
    наблюдатели. Отдельного состава у обсуждения нет и быть не должно — иначе человек
    добавлен в задачу, но не слышит, что по ней говорят.
  */
  const people = useMemo(() => {
    const byId = new Map(users.map((u) => [String(u.id), u.fullName]));
    const seen = new Set<string>();
    const out: { id: string; name: string; role: string }[] = [];
    const add = (id?: string | null, role = 'участник') => {
      const key = String(id ?? '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, name: byId.get(key) ?? '—', role });
    };
    add(creatorId, 'постановщик');
    add(assigneeId, 'исполнитель');
    for (const p of participants) add(p.user_id, p.role === 'watcher' ? 'наблюдатель' : 'соисполнитель');
    return out;
  }, [users, participants, assigneeId, creatorId]);

  /*
    Кто видел моё последнее сообщение.

    Показываем отметку только под СВОИМ последним сообщением: «просмотрено» под
    каждым превращает ленту в таблицу учёта, а спрашивают всегда про последнее.
    Себя из списка убираем, ИИ-ответы не считаем — читают их люди.
  */
  const seenBy = useMemo(() => {
    const me = String(user?.id ?? '');
    const mine = [...comments].reverse().find((c: any) => String(c.author_id) === me && !c.is_ai);
    if (!mine) return null;
    const names = readers
      .filter((r) => r.userId !== me && Number(r.lastReadId) >= Number(mine.id))
      .map((r) => r.name);
    return names.length ? { id: String(mine.id), names } : null;
  }, [comments, readers, user?.id]);

  /*
    Выпадашки шапки закрываются щелчком мимо и клавишей Esc.

    Жалоба заказчика: «невозможно закрыть эти выпадашки без перезагрузки». Кнопки
    шапки переключают своё окно сами, поэтому щелчки по самой шапке пропускаем —
    иначе нажатие на ту же кнопку закрывало бы и тут же открывало окно заново.
  */
  const closeHeadPops = useCallback(() => { setPeopleOpen(false); setHistOpen(false); setPinsOpen(false); }, []);
  useDismiss(peopleOpen || histOpen || pinsOpen, closeHeadPops, '.task-chat-head');
  const closeEmoji = useCallback(() => setEmojiOpen(false), []);
  useDismiss(emojiOpen, closeEmoji, '.chat-tools');
  const closeQuick = useCallback(() => setQuickOpen(false), []);
  useDismiss(quickOpen, closeQuick, '.chat-tools');

  /** Закреплённые сообщения: их единицы, считаем из уже загруженной ленты. */
  const pinned = comments.filter((c: any) => c.pinned_at);

  /** Кого зовём в созвон: участники задачи, кроме себя. */
  const callTo = people.map((p) => p.id).filter((id) => id !== String(user?.id ?? ''));
  const callNames = people
    .filter((p) => p.id !== String(user?.id ?? ''))
    .map((p) => p.name)
    .join(', ');

  return (
    <div className={`task-chat-box${wide ? ' task-chat-wide' : ''}`}>
      {/*
        Шапка разговора.

        В мессенджере всегда видно, с кем говоришь; здесь то же самое — название
        задачи, её этап и люди. Раньше на этом месте стоял заголовок «Чат задачи»,
        который не отвечал ни на один вопрос.
      */}
      <div className="task-chat-head">
        <span className="task-chat-badge" aria-hidden="true"><Icon name="chat" size={17} /></span>
        <div className="task-chat-title">
          <span className="task-chat-name">{wide && title ? title : 'Чат задачи'}</span>
          {/*
            Вторая строка — кто здесь. Список участников раскрывается по нажатию:
            шесть кружков в шапке занимали место, а имён всё равно не показывали.
          */}
          <button
            className="task-chat-sub"
            onClick={() => { setPeopleOpen((v) => !v); setHistOpen(false); }}
            aria-expanded={peopleOpen}
          >
            {people.length} {plural(people.length, 'участник', 'участника', 'участников')}
            {status ? ` · ${status}` : ''}
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
        <div className="task-chat-acts">
          {pinned.length > 0 && (
            <button
              className={`msg-icon${pinsOpen ? ' active' : ''}`}
              onClick={() => setPinsOpen((v) => !v)}
              title={`Закреплённые: ${pinned.length}`}
              aria-label="Закреплённые сообщения"
              aria-expanded={pinsOpen}
            >
              <Icon name="flag" size={15} />
            </button>
          )}
          {/*
            Позвонить — прямо из разговора по задаче.

            Зовём участников задачи: исполнителя, соисполнителей, постановщика. Себя из
            списка убираем — звонить себе не за чем. Комната одна и та же, «видео»
            отличается только тем, что камера включается сразу: два разных созвона ради
            этого были бы обманом.
          */}
          {/*
            Одна кнопка «Созвон» — решение заказчика.

            Выбора «с камерой или без» в задаче не было нужно: звонят, чтобы
            поговорить, а камеру включают уже в самом окне созвона. Меню с
            «Видеозвонком» только добавляло нажатие на ровном месте.
          */}
          {callTo.length > 0 && (
            <button
              className="btn btn-primary btn-sm chat-call-main"
              onClick={() => requestCall({ memberIds: callTo, projectId, taskId, title })}
              title={`Созвон: ${callNames}`}
            >
              <Icon name="phone" size={14} /> <span className="chat-call-label">Созвон</span>
            </button>
          )}
          {comments.length > 5 && (
            <button
              className={`msg-icon${searchOpen ? ' active' : ''}`}
              onClick={() => { setSearchOpen((v) => !v); if (searchOpen) setQuery(''); }}
              title="Поиск по обсуждению"
              aria-label="Поиск по обсуждению"
            >
              <Icon name="search" size={15} />
            </button>
          )}
          {/*
            Добавить человека — отдельной кнопкой, а не строкой внутри списка.

            Заказчик: «вынести добавление участника в человечка с плюсиком». Раньше
            это пряталось за подписью «2 участника», и найти его можно было только
            случайно.
          */}
          <button
            className={`msg-icon${peopleOpen ? ' active' : ''}`}
            onClick={() => { setPeopleOpen((v) => !v); setHistOpen(false); }}
            title="Участники задачи и добавление"
            aria-label="Добавить участника"
            aria-expanded={peopleOpen}
          >
            <Icon name="user-plus" size={15} />
          </button>
          <button
            className={`msg-icon${histOpen ? ' active' : ''}`}
            onClick={() => { setHistOpen((v) => !v); setPeopleOpen(false); }}
            title="История задачи"
            aria-label="История задачи"
            aria-expanded={histOpen}
          >
            <Icon name="clock" size={15} />
          </button>
          {onExpand && (
            <button className="msg-icon" onClick={onExpand} title="Развернуть на всю карточку" aria-label="Развернуть на всю карточку">
              <Icon name="maximize" size={15} />
            </button>
          )}
          {onCollapse && (
            <button className="msg-icon" onClick={onCollapse} title="Свернуть в колонку" aria-label="Свернуть в колонку">
              <Icon name="minimize" size={15} />
            </button>
          )}
        </div>
      </div>

      {/*
        Кто в разговоре и кого позвать.

        Участники задачи попадают в чат сами (постановщик, исполнитель, соисполнители,
        наблюдатели) — здесь их видно поимённо и можно добавить ещё человека: он станет
        наблюдателем задачи, а не только читателем переписки.
      */}
      {peopleOpen && (
        <div className="chat-pop chat-people-pop" data-pop>
          {people.map((p) => (
            <span key={p.id} className="chat-pop-row chat-person-row">
              <span className="msg-avatar" aria-hidden="true">{initials(p.name)}</span>
              {p.name} <span className="dim">· {p.role}</span>
            </span>
          ))}
          {/*
            Приглашения как отдельного шага у нас нет — и это сознательно.

            Человек добавляется сразу: задача появляется у него в «Наблюдаю», приходит
            уведомление, дальше он читает переписку и отвечает. Ждать согласия на
            доступ к рабочей задаче внутри своей же компании незачем.
          */}
          <span className="dim chat-pop-note">
            Добавленный сразу получит доступ к задаче, уведомление и увидит её в «Наблюдаю».
            Подтверждать приглашение не нужно.
          </span>
          <label className="chat-pop-add">
            <Icon name="user-plus" size={14} />
            <select
              className="input"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                void api.addTaskParticipant(taskId, id, 'watcher').then(() => { setPeopleOpen(false); onRefresh(); });
              }}
              aria-label="Добавить участника"
            >
              <option value="">Добавить участника…</option>
              {users
                .filter((u) => !people.some((p) => p.id === String(u.id)))
                .map((u) => <option key={u.id} value={String(u.id)}>{u.fullName}</option>)}
            </select>
          </label>
        </div>
      )}

      {/*
        История задачи — панелью из шапки, а не хвостом под перепиской.

        Раньше она лежала ниже поля ввода: чтобы дописать сообщение, приходилось
        проматывать два десятка строк «изменил поля». Разговор и журнал — разные вещи.
      */}
      {histOpen && (
        <div className="chat-pop chat-hist-pop" data-pop>
          {history.map((a: any) => {
            const to = a.kind === 'commented' && a.detail?.commentId ? String(a.detail.commentId) : null;
            const line = `${new Date(a.created_at).toLocaleString('ru-RU')} · ${a.actor_name ?? 'система'} · ${activityText(a)}`;
            // Строка про сообщение ведёт к самому сообщению: история, из которой нельзя
            // попасть в то, о чём она говорит, отсылает в никуда.
            return to
              ? <button key={a.id} className="activity-row activity-link" onClick={() => { setHistOpen(false); void goToMessage(to); }} title="Перейти к сообщению">{line}</button>
              : <div key={a.id} className="dim activity-row">{line}</div>;
          })}
          {activity.length > 5 && (
            <button className="msg-act" onClick={() => setAllHistory((v) => !v)}>
              {allHistory ? 'Свернуть историю' : `Показать всю историю (${activity.length})`}
            </button>
          )}
        </div>
      )}

      {/*
        Закреплённые — свёрнуты в одну строку.

        «Читайте прежде всего» должно быть видно сразу, но занимать пол-экрана
        закреп не должен: строка с количеством, по нажатию — список с переходом.
      */}
      {pinned.length > 0 && pinsOpen && (
        <div className="task-pins" data-pop>
          {pinned.map((c: any) => (
            <button key={c.id} className="task-pin" onClick={() => { setPinsOpen(false); void goToMessage(String(c.id)); }}>
              <Icon name="flag" size={12} />
              <span className="task-pin-author">{c.is_ai ? AI_MENTION_NAME : c.author_name}:</span>
              <span className="task-pin-body">{String(c.body ?? 'вложение').slice(0, 140)}</span>
            </button>
          ))}
        </div>
      )}

      {/* Поиск появляется по лупе: постоянное поле над лентой съедает место,
          а ищут в обсуждении редко. */}
      {searchOpen && (
        <input
          className="input chat-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по обсуждению"
          aria-label="Поиск по обсуждению"
          autoFocus
        />
      )}
      {q && (
        <div className="dim chat-found">
          {shown.length ? `Найдено сообщений: ${shown.length}` : 'Ничего не нашлось'}
        </div>
      )}

      {comments.length === 0 && (
        <EmptyState compact icon="chat" title="Обсуждения ещё не было"
          hint="Здесь остаётся история решений по задаче. Помощника можно спросить тут же: «@AI что от меня требуется?»" />
      )}

      <div
        className="msg-feed"
        ref={feedRef}
        onScroll={(e) => {
          const el = (scroller() ?? e.currentTarget) as HTMLElement;
          const bottom = nearBottom(el);
          atBottomRef.current = bottom;
          setAtBottom(bottom);
          if (bottom) setUnseen(0);
          /*
            Докрутили до верха — поднимаем остальную переписку.

            Кнопка «показать всю» осталась для тех, кто ищет глазами, но в мессенджере
            история достаётся прокруткой: человек тянет ленту вверх и ждёт, что она
            продолжится, а не что появится кнопка.
          */
          if (el.scrollTop < 60 && !fullyLoaded && !olderBusy) {
            setOlderBusy(true);
            reload(true);
          }
        }}
        // Файл можно перетащить прямо в переписку — то же, что вставка из буфера.
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const list = Array.from(e.dataTransfer.files ?? []);
          if (list.length) { e.preventDefault(); void attach(list); }
        }}
      >
        {/* Показан хвост переписки — остальное поднимается кнопкой. Появляется, только
            когда наверху действительно что-то есть. */}
        {!fullyLoaded && comments.length >= 100 && (
          <button className="btn btn-ghost btn-sm chat-earlier" onClick={() => reload(true)}>
            <Icon name="chevron-up" size={13} /> Показать всю переписку
          </button>
        )}
        {/*
          Своё сообщение, пока оно летит на сервер.

          Выглядит как обычное, но приглушено и подписано «отправляется». Пропадёт
          само, когда придёт настоящее: лента перечитывается целиком.
        */}
        {sending && (
          <div className="msg msg-mine msg-sending">
            <div className="msg-avatar" aria-hidden="true">{initials(meName)}</div>
            <div className="msg-main">
              <div className="msg-head">
                <b className="msg-name">{meName}</b>
                <span className="msg-time">отправляется…</span>
              </div>
              <MessageText text={sending.body} className="msg-text" />
            </div>
          </div>
        )}
        {/* Написанное без сети: висит в ленте, пока не уйдёт из очереди (волна 9) */}
        {queued.map((q) => (
          <div key={q.id} className="msg msg-mine msg-sending msg-queued">
            <div className="msg-avatar" aria-hidden="true">{initials(meName)}</div>
            <div className="msg-main">
              <div className="msg-head">
                <b className="msg-name">{meName}</b>
                <span className="msg-time">{q.status === 'pending' ? 'ожидает сети' : 'не отправлено'}</span>
              </div>
              <MessageText text={String((q.body as { body?: string })?.body ?? '')} className="msg-text" />
            </div>
          </div>
        ))}
        {shown.map((c, i) => {
          const prev = shown[i - 1];
          const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(c.created_at).toDateString();
          const grouped = !newDay && !q && sameGroup(prev, c);
          const mine = String(c.author_id) === String(user?.id ?? '') && !c.is_ai;
          const name = c.is_ai ? AI_MENTION_NAME : c.author_name;
          return (
            <div key={c.id}>
              {newDay && <div className="chat-day">{dayLabel(c.created_at)}</div>}
              <div
                data-msg={String(c.id)}
                className={`msg${mine ? ' msg-mine' : ''}${c.is_ai ? ' msg-ai' : ''}`
                  + `${grouped ? ' msg-grouped' : ''}${highlight === String(c.id) ? ' msg-found' : ''}`
                  + `${ctxFor?.id === String(c.id) ? ' msg-ctx-open' : ''}`}
                /* Правая кнопка — меню сообщения, как в Telegram. На касании его
                   открывает долгое нажатие: см. longPressProps. */
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Выделение снимаем сразу: щелчок по пункту меню его сбросит.
                  setCtxFor({
                    id: String(c.id),
                    at: { x: e.clientX, y: e.clientY },
                    picked: selectionIn(e.currentTarget as Element),
                  });
                }}
                {...longPressProps((at) => setCtxFor({ id: String(c.id), at, picked: '' }))}
              >
                <div className="msg-avatar" aria-hidden="true">
                  {grouped ? '' : c.is_ai ? <Icon name="robot" size={14} /> : initials(name)}
                </div>
                <div className="msg-main">
                  {/*
                    Имя автора — цветом, как в любом мессенджере.

                    Цвет закреплён за человеком (считается из его id), поэтому в длинной
                    ленте видно, кто говорит, не вчитываясь в подпись. Шесть оттенков —
                    больше глаз всё равно не различает.
                  */}
                  {!grouped && <b className={`msg-name msg-who-${whoColor(String(c.author_id))}`}>{name}</b>}

                  {/* Цитата: без неё «да, согласен» через десять реплик — согласие
                      неизвестно с чем. Клик ведёт к исходному сообщению. */}
                  {c.reply_to_id && c.reply_body && (
                    <button className="msg-quote" onClick={() => goToMessage(String(c.reply_to_id), c.reply_body)} title="Перейти к сообщению">
                      <b className="msg-quote-author">{c.reply_author}</b>
                      <span className="msg-quote-text">{String(c.reply_body).slice(0, 200)}</span>
                    </button>
                  )}

                  {c.body && (
                    <MessageText
                      text={c.body}
                      className="msg-text"
                      mark={quoteMark?.id === String(c.id) ? quoteMark.text : null}
                    />
                  )}

                  {/* Несколько файлов — одно сообщение, как в переписке. Старые сообщения
                      приходят с одним файлом и показываются так же. */}
                  {((c as any).files?.length
                    ? (c as any).files
                    : c.file_id ? [{ fileId: String(c.file_id), name: c.file_name ?? 'файл' }] : []
                  ).map((f: any) => (
                    <ChatAttachment
                      key={String(f.fileId)}
                      fileId={String(f.fileId)}
                      fileName={f.name ?? 'файл'}
                      onOpen={() => openPreview(String(f.fileId))}
                    />
                  ))}

                  {/* Время — в углу пузыря, как в мессенджере: в строке с именем оно
                      отодвигало подпись, а взгляд ищет его именно справа внизу. */}
                  <span className="msg-stamp" title={new Date(c.created_at).toLocaleString('ru-RU')}>
                    {stampLabel(c.created_at)}{c.edited_at ? ' · изменено' : ''}
                  </span>

                  <div className="msg-foot">
                    {(c.reactions ?? []).map((r: any) => (
                      <button
                        key={r.emoji}
                        className={r.mine ? 'reaction mine' : 'reaction'}
                        onClick={() => react(String(c.id), r.emoji)}
                        title={r.mine ? 'Снять свою реакцию' : 'Поддержать'}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                    {/* Ответы в ветке — не действие, а состояние разговора: строка
                        остаётся на виду, в меню её прятать незачем. */}
                    {Number(c.reply_count ?? 0) > 0 && (
                      <button
                        className="msg-act msg-act-thread"
                        onClick={() => { void openThread(String(c.id)); }}
                        title="Показать ответы в ветке"
                      >
                        <Icon name="chat" size={12} /> {c.reply_count} {plural(Number(c.reply_count), 'ответ', 'ответа', 'ответов')}
                      </button>
                    )}
                  </div>

                  {/*
                    Ветка раскрывается прямо под своим сообщением.

                    Не второй колонкой: в карточке задачи их и так две, третья
                    превратила бы разговор в щель. Свернули — вернулись в ленту.
                  */}
                  {thread && thread.rootId === String(c.id) && (
                    <div className="task-thread">
                      <div className="task-thread-head">
                        <span className="dim">
                          Ветка · {thread.replies.length} {plural(thread.replies.length, 'ответ', 'ответа', 'ответов')}
                        </span>
                        <button className="msg-act" onClick={() => setThread(null)}>Свернуть</button>
                      </div>
                      {thread.replies.map((r: any) => (
                        <div key={r.id} className={`msg msg-thread-reply${r.pending ? ' msg-sending' : ''}`}>
                          <div className="msg-avatar" aria-hidden="true">{initials(r.is_ai ? AI_MENTION_NAME : r.author_name)}</div>
                          <div className="msg-main">
                            <div className="msg-head">
                              <b className="msg-name">{r.is_ai ? AI_MENTION_NAME : r.author_name}</b>
                              <span className="msg-time">{stampLabel(r.created_at)}</span>
                            </div>
                            {r.reply_body && (
                              <div className="msg-quote task-thread-quote">
                                <b>{r.reply_author ?? ''}</b>: {String(r.reply_body).slice(0, 200)}
                              </div>
                            )}
                            {r.body && <MessageText text={r.body} className="msg-text" />}
                            {r.file_id && (
                              <ChatAttachment
                                fileId={String(r.file_id)}
                                fileName={r.file_name ?? 'файл'}
                                onOpen={() => openPreview(String(r.file_id))}
                              />
                            )}
                          </div>
                        </div>
                      ))}
                      {threadQuote && (
                        <div className="msg-quote task-thread-quote">
                          <b>{threadQuote.author}</b>: {threadQuote.excerpt.slice(0, 200)}
                          <button className="msg-act" onClick={() => setThreadQuote(null)}>Убрать</button>
                        </div>
                      )}
                      <div className="task-thread-input">
                        <textarea
                          className="input"
                          rows={2}
                          autoFocus
                          value={threadBody}
                          onChange={(e) => setThreadBody(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendToThread(); } }}
                          placeholder="Ответить в ветке"
                          aria-label="Ответить в ветке"
                        />
                        <label className="anthill-ctx" title="Ответ увидят и те, кто ветку не открывал">
                          <input type="checkbox" checked={alsoInChannel} onChange={(e) => setAlsoInChannel(e.target.checked)} />
                          Показать и в ленте
                        </label>
                        <button className="btn btn-primary btn-sm" onClick={() => { void sendToThread(); }} disabled={busy || !threadBody.trim()}>
                          Ответить
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/*
        «Просмотрено» — под лентой, как в мессенджере.

        Одна строка на весь разговор, а не отметка у каждого сообщения: отправителю
        нужно знать, дошло ли ПОСЛЕДНЕЕ, а стена галочек только шумит. Имена названы
        прямо: «просмотрено двумя» не отвечает на вопрос, кем именно.
      */}
      {seenBy && !q && (
        <div className="chat-seen" title={`Просмотрено: ${seenBy.names.join(', ')}`}>
          <Icon name="check" size={12} />
          Просмотрено: {seenBy.names.length > 2
            ? `${seenBy.names.slice(0, 2).join(', ')} и ещё ${seenBy.names.length - 2}`
            : seenBy.names.join(', ')}
        </div>
      )}

      {/*
        Меню сообщения. Собирается по тому, что с этой репликой вообще можно сделать:
        чужую не правят и не удаляют, ответ помощнику в ветку не уводят.
      */}
      {ctxFor && (() => {
        const c: any = comments.find((x: any) => String(x.id) === ctxFor.id);
        if (!c) return null;
        const mine = String(c.author_id) === String(user?.id ?? '') && !c.is_ai;
        const node = document.querySelector(`[data-msg="${ctxFor.id}"]`);
        const picked = ctxFor.picked;
        const items = [
          {
            label: picked ? 'Ответить с цитатой' : 'Ответить',
            icon: 'reply' as const,
            onClick: () => startReply(c, node, picked),
          },
          {
            label: picked ? 'В ветку с цитатой' : 'Ответить в ветке',
            icon: 'chat' as const,
            onClick: () => startThreadReply(c, node, picked),
          },
          // Своё меню забрало у браузера его «Копировать» — возвращаем выделенное.
          ...(picked ? [{
            label: 'Копировать выделенное',
            icon: 'copy' as const,
            onClick: () => { void navigator.clipboard?.writeText(picked).catch(() => undefined); },
          }] : []),
          ...(c.body ? [{
            label: 'Копировать текст',
            icon: 'copy' as const,
            onClick: () => { void navigator.clipboard?.writeText(String(c.body)).catch(() => undefined); },
          }] : []),
          {
            label: c.pinned_at ? 'Открепить' : 'Закрепить',
            icon: 'flag' as const,
            onClick: () => { void togglePin(String(c.id), !c.pinned_at); },
          },
          ...(mine ? [
            {
              label: 'Изменить',
              icon: 'edit' as const,
              onClick: () => { setEditing({ id: String(c.id), body: c.body }); setBody(c.body); },
            },
            { label: 'Удалить', icon: 'trash' as const, danger: true, onClick: () => remove(String(c.id)) },
          ] : []),
        ];
        return (
          <MessageMenu
            at={ctxFor.at}
            reactions={REACTIONS}
            onReact={(emoji) => react(String(c.id), emoji)}
            items={items}
            onClose={() => setCtxFor(null)}
          />
        );
      })()}

      {err && <div className="error-text">{err}</div>}

      {/* Предложения помощника: применяет их человек, и это принципиально —
          сам ИИ задачу не меняет. */}
      {advice && (advice.checklist.length > 0 || advice.suggestion) && (
        <div className="ai-advice">
          {advice.checklist.length > 0 && (
            <>
              <div className="ai-advice-head">Предложенные шаги</div>
              <ul className="ai-advice-list">
                {advice.checklist.map((step, i) => <li key={i}>{step}</li>)}
              </ul>
              <button className="btn btn-sm" onClick={acceptChecklist} disabled={busy}>
                <Icon name="check" size={13} /> Добавить в чек-лист
              </button>
            </>
          )}
          {advice.suggestion && (
            <div className="ai-advice-suggest">
              <Icon name="alert" size={13} /> {advice.suggestion.label || 'Помощник предлагает изменить задачу'} —
              примените это сами во вкладке «Обзор»: менять задачу за вас он не станет.
            </div>
          )}
        </div>
      )}

      {/* Строка «печатает…» под лентой, как в мессенджере: она о том, что
          происходит прямо сейчас, и потому стоит у поля ввода, а не в шапке. */}
      {Object.keys(typing).length > 0 && (
        <div className="chat-typing">
          <span className="chat-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          {Object.values(typing).map((t) => t.name).join(' и ')}
          {Object.keys(typing).length > 1 ? ' печатают…' : ' печатает…'}
        </div>
      )}

      {/* Кнопка появляется, только когда есть что догонять: пустая стрелка вниз
          в спокойной переписке — лишний шум. */}
      {!atBottom && unseen > 0 && (
        <button className="btn btn-primary btn-sm chat-jump-new" onClick={() => toBottom(true)}>
          <Icon name="arrow-down" size={13} /> {unseen} {plural(unseen, 'новое сообщение', 'новых сообщения', 'новых сообщений')}
        </button>
      )}

      {/* Быстрые вопросы к ИИ — по кнопке в поле ввода: пять кнопок над строкой
          занимали место каждый день ради нажатия раз в неделю. */}
      {quickOpen && (
        <div className="ai-quick" data-pop>
          {QUICK_ASKS.map((qa) => (
            <button key={qa.label} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setQuickOpen(false); ask(qa.ask); }}>
              {qa.label}
            </button>
          ))}
        </div>
      )}

      {/* Кому отвечаем — видно прямо над полем, как в мессенджере: с именем,
          куском реплики и крестиком «передумал». */}
      {replyTo && (
        <div className="comment-reply-to">
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

      {/* Кому отвечаем или что правим — видно прямо над полем, а не угадывается. */}
      {editing && (
        <div className="comment-reply-to">
          <Icon name={editing ? 'edit' : 'reply'} size={13} />
          <span className="dim">
            Правите своё сообщение
          </span>
          <button className="msg-act" onClick={() => { setEditing(null); setBody(''); }}>Отмена</button>
        </div>
      )}

      {/* Вложения перед отправкой: видно, что уйдёт, и каждое можно убрать по отдельности. */}
      {pending.map((p, i) => (
        <div className="chat-pending" key={`${p.file.name}:${p.file.size}:${i}`}>
          {p.url
            ? <img className="chat-pending-img" src={p.url} alt={p.file.name} />
            : <Icon name="paperclip" size={16} />}
          <span className="chat-pending-name">
            {p.file.name} <span className="dim">· {humanSize(p.file.size)}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => dropPending(i)} title="Убрать вложение" aria-label="Убрать вложение">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}

      {/*
        Поле ввода — одной «таблеткой» внизу, как в мессенджере.

        Скрепка слева, текст посередине, справа смайлы, голос и круглая отправка.
        Раньше кнопки стояли строкой ПОД полем и уезжали за край экрана вместе с
        ним: поле было частью прокручиваемой колонки, а не дном разговора.
      */}
      <div className="comment-input" ref={composeRef}>
        <label className="chat-tool" title="Прикрепить файл — или просто вставьте скриншот через Ctrl+V">
          <Icon name="paperclip" size={17} />
          {/* multiple: выбрать сразу несколько снимков — обычное дело, а уходил только первый. */}
          <input
            type="file"
            hidden
            multiple
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              if (list.length) void attach(list);
              e.currentTarget.value = '';
            }}
          />
        </label>
        <MentionField
          value={body}
          users={mentionUsers}
          onChange={(v) => { setBody(v); if (v.trim()) pingTyping(); }}
          // Упомянутого нужно позвать: без этого «@Юрий, посмотри» он увидит,
          // только если сам зайдёт в задачу.
          onMention={(userId) => {
            // помощник участником задачи не становится — он не человек
            if (userId === AI_MENTION_ID) return;
            void api.addTaskParticipant(taskId, userId, 'watcher').catch(() => undefined);
          }}
          rows={1}
          autoGrow
          placeholder={pending ? 'Подпись к вложению…' : 'Нажмите @, чтобы позвать человека или помощника'}
          onEnter={send}
        />
        <div className="chat-tools">
          <button
            className={`chat-tool${quickOpen ? ' active' : ''}`}
            onClick={() => { setQuickOpen((v) => !v); setEmojiOpen(false); }}
            disabled={busy}
            title="Быстрые вопросы помощнику"
            aria-label="Быстрые вопросы помощнику"
            aria-expanded={quickOpen}
          >
            <Icon name="sparkles" size={17} />
          </button>
          <span className="chat-tool-wrap">
            <button
              className={`chat-tool${emojiOpen ? ' active' : ''}`}
              onClick={() => { setEmojiOpen((v) => !v); setQuickOpen(false); }}
              title="Смайлы"
              aria-label="Смайлы"
              aria-expanded={emojiOpen}
            >
              <Icon name="smile" size={17} />
            </button>
            {emojiOpen && (
              <span className="react-pop chat-emoji-pop" data-pop>
                {REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    className="react-pop-btn"
                    onClick={() => { setBody((v) => v + emoji); setEmojiOpen(false); }}
                  >
                    {emoji}
                  </button>
                ))}
              </span>
            )}
          </span>
          <button
            className={`chat-tool${voice.recording ? ' recording' : ''}`}
            onClick={voice.toggle}
            disabled={busy || voice.transcribing}
            title={voice.recording ? 'Остановить запись' : 'Записать голосовое'}
            aria-label={voice.recording ? 'Остановить запись' : 'Записать голосовое'}
          >
            <Icon name={voice.recording ? 'stop' : 'mic'} size={17} />
          </button>
          <button
            className="chat-send"
            disabled={busy || (!body.trim() && !pending)}
            onClick={send}
            title={editing ? 'Сохранить' : 'Отправить'}
            aria-label={editing ? 'Сохранить' : 'Отправить'}
          >
            <Icon name={editing ? 'check' : 'send'} size={17} />
          </button>
        </div>
      </div>
      {/* Записанное — сначала послушать. Отправлять вслепую то, что человек только что
          наговорил, значит слать в задачу кашель и «эээ» без возможности передумать. */}
      {note && (
        <div className="voice-note">
          <audio className="voice-note-player" src={note.url} controls preload="metadata" />
          <button className="btn btn-primary btn-sm" onClick={() => { void sendNote(); }} disabled={noteBusy}>
            {noteBusy ? 'Отправляю…' : 'Отправить'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => { void noteToText(); }} disabled={noteBusy} title="Распознать и положить текстом в поле ввода">
            В текст
          </button>
          <button className="btn btn-ghost btn-sm" onClick={dropNote} disabled={noteBusy}>Удалить</button>
        </div>
      )}
      <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} className="nl-voice" />

      {preview && <Lightbox items={preview.items} index={preview.index} onClose={() => setPreview(null)} />}
    </div>
  );
}
