import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import './support-dock.css';
import { api, ApiError } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { collectSupportContext, describeContext } from '../../lib/support-context';
import { shrinkImage } from '../../lib/image-shrink';
import { requestCall } from '../../lib/notifications';
import { stampLabel } from '../../lib/chat-text';
import { useAuth } from '../../state/auth';
import { apiUrl } from '../../lib/origin';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { Icon } from '../Icon';
import { VoiceStatus } from '../VoiceStatus';
import { MessageText } from '../MessageText';
import type { SupportConversation, SupportDesk, SupportQueueItem } from '../../types';
import { OptionSelect } from '../ui/option-select';
import { useEnterSend } from '../../hooks/useEnterSend';
import type { SupportOpen } from './SupportDock';
import type { CareProgress } from '../../lib/care-rules';
// консьерж (ТЗ-29) — своим куском: панель службы заботы входит в стартовую сборку
const ConciergeHead = lazy(() => import('./Concierge').then((m) => ({ default: m.ConciergeHead })));
const ConciergeCards = lazy(() => import('./Concierge').then((m) => ({ default: m.ConciergeCards })));
const ConciergeTools = lazy(() => import('./Concierge').then((m) => ({ default: m.ConciergeTools })));

/** Оценка: четыре лица вместо звёзд — на них отвечают, не задумываясь (ТЗ-8, разд. 31). */
const FACES: { score: number; face: string; label: string }[] = [
  { score: 1, face: '😞', label: 'Плохо' },
  { score: 2, face: '😐', label: 'Так себе' },
  { score: 3, face: '🙂', label: 'Хорошо' },
  { score: 4, face: '😍', label: 'Отлично' },
];

/** Почему низкая оценка — списком, а не полем: так отвечают, а не закрывают окно. */
const REASONS = ['долго ждал', 'проблема не решена', 'сложно объяснили', 'пришлось повторять', 'другое'];

/** Время ответа человеческими словами: «около 30 секунд», а не «28.4 s». */
function etaText(sec: number | null): string {
  if (!sec) return 'Ищем свободного специалиста';
  if (sec < 90) return `Ответим примерно за ${Math.max(10, Math.round(sec / 10) * 10)} сек`;
  const min = Math.round(sec / 60);
  return `Ответим примерно за ${min} ${min === 1 ? 'минуту' : min < 5 ? 'минуты' : 'минут'}`;
}

/**
 * Служба заботы — панель поверх CRM (ТЗ-8).
 *
 * Открывается кнопкой в правом нижнем углу из любого раздела и не уводит человека
 * со страницы: он видит свою задачу и разговор одновременно — именно поэтому
 * панель, а не отдельный экран (разд. 2.1, 4).
 *
 * Что здесь принципиально:
 *
 * 1. Никакой анкеты. Поле ввода и «Отправить» — всё. Тема, категория и номер
 *    обращения человеку не нужны (разд. 2.2).
 * 2. Кнопка «Позвать старшего специалиста» видна всегда, пока разговор ведёт первая линия (разд. 8).
 * 3. Что уходит специалисту — видно до отправки: строка контекста внизу (разд. 50).
 * 4. Закрывает разговор сам человек: «всё работает?» с оценкой (разд. 21, 31).
 */
/** Три кнопки над вводом (п. 2.2) — дословно по документу. */
const QUICK = [
  'Перенести мои задачи и проекты из другого сервиса за 10 мин',
  'Видео-созвон Huddle с показом экрана за 20 сек',
  'Помочь настроить ИИ-секретаря, доску или пригласить команду',
] as const;

/** Что окно сообщает островку: кто ведёт разговор, прогресс и пришло ли новое. */
export interface PanelInfo { agent: string | null; progress: CareProgress | null; lastIncoming: string | null }

export interface PanelProps {
  /**
   * Консоль техотдела: панель стоит колонкой рядом с очередью, а не окошком поверх
   * страницы, и без кнопки-кружка — там специалист не просит помощи, а оказывает её.
   */
  embedded?: boolean;
  /** Просьба открыть: с номером обращения, с текстом, голосом или созвоном. */
  request?: SupportOpen | null;
  /** Окно снаружи (островок заботы): открыто ли, свёрнуто ли в кружок. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  minimized?: boolean;
  onMinimize?: () => void;
  onInfo?: (info: PanelInfo) => void;
}

export default function SupportPanel({ embedded = false, request, open: openProp, onOpenChange, minimized = false, onMinimize, onInfo }: PanelProps) {
  const { user } = useAuth();
  const [openSelf, setOpenSelf] = useState(false);
  const open = openProp ?? openSelf;
  const setOpen = useCallback((v: boolean) => { if (onOpenChange) onOpenChange(v); else setOpenSelf(v); }, [onOpenChange]);
  /** Шторка на телефоне: половина экрана или весь (п. 3.1). */
  const [full, setFull] = useState(false);
  /** Ссылка «продолжить на другом устройстве» скопирована — короткая отметка. */
  const [handoff, setHandoff] = useState('');
  const [desk, setDesk] = useState<SupportDesk | null>(null);
  const [conv, setConv] = useState<SupportConversation | null>(null);
  /** Свежий разговор для действий, которые идут сразу за отправкой (созвон по кнопке). */
  const convRef = useRef<SupportConversation | null>(null);
  convRef.current = conv;
  const busyRef = useRef(false);
  const askCallRef = useRef<(() => Promise<void>) | null>(null);
  const mineRef = useRef(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [view, setView] = useState<'chat' | 'history' | 'queue'>('chat');
  /** Очередь дежурного: кто ждёт ответа прямо сейчас. */
  const [queue, setQueue] = useState<SupportQueueItem[]>([]);
  const [lowReason, setLowReason] = useState<number | null>(null);
  /** Диагностика и подключение инженера — инструменты дежурного (MVP 2). */
  const [diag, setDiag] = useState<Awaited<ReturnType<typeof api.supportDiagnostics>> | null>(null);
  const [tools, setTools] = useState(false);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  /** Внутренние заметки: их не видит клиент — ни здесь, ни одной ручкой. */
  const [notes, setNotes] = useState<Awaited<ReturnType<typeof api.supportNotes>>>([]);
  const [noteText, setNoteText] = useState('');
  /** Лента событий: что с обращением происходило — вместо чтения всей переписки. */
  const [timeline, setTimeline] = useState<Awaited<ReturnType<typeof api.supportTimeline>> | null>(null);
  /** Кому из инженеров открыт разговор: доступ выдаётся на срок и отзывается. */
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.supportEngineers>>>([]);
  /** Подсказка копилота дежурному: суть, что проверить, что сказать человеку. */
  const [copilot, setCopilot] = useState<Awaited<ReturnType<typeof api.supportCopilot>> | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  /*
    Голосом — в любую службу заботы (задача #1345).

    Человек, у которого что-то сломалось, часто не может или не хочет печатать: с
    телефона, на бегу, с трясущимися руками. Тот же микрофон, что в чатах и быстрой
    команде: сказал — текст лёг в поле, проверил, отправил. Одна и та же кнопка у
    клиента в CRM и у специалиста в консоли: панель одна, микрофон один.
  */
  const holdSend = useRef(false);
  const voice = useVoiceInput((said) => {
    if (holdSend.current) {
      holdSend.current = false;
      const body = text.trim() ? `${text.trim()} ${said}` : said;
      void (mineRef.current ? send(body) : replyAsAgent(body));
      return;
    }
    setText((prev) => (prev.trim() ? `${prev.trim()} ${said}` : said));
  });
  /** Нажатие на микрофон: короткое — переключатель, удержание — сказал и отпустил. */
  const press = useRef<number | null>(null);
  const micDown = () => {
    if (voice.recording) return;
    press.current = Date.now();
    void voice.start();
  };
  const micUp = () => {
    if (press.current === null) { if (voice.recording) voice.stop(); return; }
    const held = Date.now() - press.current >= 400;
    press.current = null;
    if (held) { holdSend.current = true; voice.stop(); }
  };
  /*
    Чужое обращение, открытое специалистом.

    Панель по любому событию перечитывает «свой» разговор; без этой отметки взятое из
    очереди обращение при первом же ответе клиента подменялось бы пустой панелью «что
    случилось?» — и специалист терял разговор ровно в момент, когда в нём появлялось
    новое. Пока отметка стоит, перечитываем именно это обращение.
  */
  const foreignId = useRef<string | null>(null);
  /** То же — состоянием: от него зависит, с какой стороны стола сидит человек. */
  const [foreign, setForeign] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.supportDesk();
      setDesk(d);
      if (foreignId.current) {
        setConv(await api.supportConversation(foreignId.current));
      } else {
        setConv(d.conversation);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Служба заботы сейчас недоступна');
    }
  }, []);

  /** Открыть конкретное обращение — из очереди консоли или по всплывашке. */
  const openConversation = useCallback(async (id: string) => {
    foreignId.current = id;
    setForeign(id);
    setOpen(true);
    setView('chat');
    setTools(false);
    setErr('');
    try { setConv(await api.supportConversation(id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть обращение'); }
  }, [setOpen]);

  /** Вернуться к своему разговору: чужое обращение больше не держим. */
  const leaveForeign = () => {
    foreignId.current = null;
    setForeign(null);
    setConv(desk?.conversation ?? null);
    setTools(false);
  };

  // Панель узнаёт о себе, только когда её открыли (вне консоли её и монтируют по делу).
  useEffect(() => { if ((open || !embedded) && !desk) void load(); }, [open, embedded, desk, load]);

  /*
    Позвали снаружи — из меню, командной строки, пустого экрана, жеста или заминки.

    Просьба может нести готовый текст (заминка, сбой экрана), голос (шторка встряхивания)
    или созвон (кнопка Huddle): человек сделал один жест — дальше без лишних нажатий.
  */
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!request || handled.current === request.n) return;
    handled.current = request.n;
    if (request.conversationId) { void openConversation(request.conversationId); return; }
    setOpen(true);
    if (request.text) void (request.call ? send(request.text).then(() => askCallRef.current?.()) : send(request.text));
    else if (request.call) void quick(QUICK[1]);
    if (request.voice) { holdSend.current = true; void voice.start(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  /*
    Очередь дежурного.

    Обновляем при открытии вкладки и по событию: человек, которому ответили не сразу,
    запоминает именно это ожидание — очередь не должна жить до перезагрузки страницы.
  */
  const loadQueue = useCallback(() => {
    api.supportQueue().then(setQueue).catch(() => undefined);
  }, []);
  useEffect(() => { if (open && view === 'queue') loadQueue(); }, [open, view, loadQueue]);
  useEffect(() => {
    if (!desk?.isAgent) return undefined;
    const socket = getSocket();
    const onQueue = () => loadQueue();
    socket.on('support.queue.changed', onQueue);
    return () => { socket.off('support.queue.changed', onQueue); };
  }, [desk?.isAgent, loadQueue]);

  /*
    Инструменты дежурного открываются по кнопке и грузятся тогда же.

    Диагностика, список коллег и заведённые баги нужны в одном разговоре из десяти —
    тянуть их вместе с каждым открытием панели значит платить за них всегда.
  */
  const openTools = async (id: string) => {
    setTools((v) => !v);
    if (diag) return;
    const [d, users] = await Promise.all([
      api.supportDiagnostics(id).catch(() => null),
      api.listUsers().then((u) => u.map((x: { id: string; fullName: string }) => ({ id: String(x.id), fullName: x.fullName }))).catch(() => []),
    ]);
    setDiag(d);
    setPeople(users);
    await loadGrants(id);
    setNotes(await api.supportNotes(id).catch(() => []));
    setTimeline(await api.supportTimeline(id).catch(() => null));
  };

  /** Позвать инженера — в ТОТ ЖЕ разговор: объяснять второй раз человек не должен. */
  const addEngineer = async (userId: string) => {
    if (!conv || !userId) return;
    setBusy(true);
    try { setConv(await api.supportAddEngineer(conv.id, userId)); await loadGrants(conv.id); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось подключить'); }
    finally { setBusy(false); }
  };

  /** Баг из разговора: описание, шаги и контекст уезжают в задачу сами. */
  const createBug = async () => {
    if (!conv) return;
    setBusy(true);
    try {
      const res = await api.supportCreateBug(conv.id);
      setConv(res.conversation);
      setDiag(await api.supportDiagnostics(conv.id).catch(() => null));
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось завести задачу'); }
    finally { setBusy(false); }
  };

  /**
   * Созвон из поддержки (разд. 13).
   *
   * Комнату поднимает обычный созвон CRM — со звуком, видео, демонстрацией экрана и
   * записью. Мы лишь помечаем, что разговор идёт по этому обращению: по пометке итог
   * с расшифровкой и разбором вернётся сюда же.
   */
  /**
   * Попросить созвон.
   *
   * Никому не звонит: вторая сторона увидит карточку и ответит. Комната поднимется,
   * только если она согласится, — звонить человеку, который может быть на совещании или
   * за рулём, продукт не должен.
   */
  const askCall = async () => {
    const c = convRef.current;
    if (!c || c.call) return;
    setBusy(true); setErr('');
    try { setConv(await api.supportRequestCall(c.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** «Сейчас неудобно» — такой же обычный ответ, как согласие. */
  const declineCall = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportDeclineCall(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** Согласиться: комнату и гостевую ссылку поднимает согласившаяся сторона. */
  const startHuddle = async () => {
    if (!conv) return;
    setBusy(true); setErr('');
    try {
      const room = await api.startCall(undefined, true);
      /*
        Ссылку на комнату кладём в разговор — гостевую.

        Специалист и человек в РАЗНЫХ организациях: обычное приглашение на созвон до
        собеседника не дойдёт, оно ходит внутри компании. Гостевая ссылка работает
        всегда и не даёт ничего, кроме этой комнаты: вход через комнату ожидания, и
        её можно отозвать.
      */
      const link = await api.createGuestLink({
        roomId: String(room.id),
        label: `Служба заботы · ${conv.subject}`.slice(0, 80),
        ttlHours: 4,
      });
      setConv(await api.supportAcceptCall(conv.id, String(room.id), link.url));
      // Своим (когда обращение внутри одной организации) звоним и обычным приглашением.
      const to = mineConversation
        ? conv.participants.map((p) => String(p.user_id)).filter((uid) => uid !== String(user?.id ?? ''))
        : [];
      // Входим в ТУ ЖЕ комнату, на которую выписана ссылка: вторую оболочка поднимать не должна.
      requestCall({ memberIds: to, roomId: String(room.id), title: `Служба заботы · ${conv.subject}`.slice(0, 80) });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось начать созвон. Разговор сохранён — попробуйте ещё раз.');
    } finally { setBusy(false); }
  };

  /** Слово человека по предложенному действию: без него не происходит ничего. */
  const decideAction = async (actionId: string, allow: boolean) => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportDecideAction(conv.id, actionId, allow)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const undoAction = async (actionId: string) => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportUndoAction(conv.id, actionId)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось вернуть'); }
    finally { setBusy(false); }
  };

  /** Вернуть помощника: после подключения человека он молчит, пока его не позовут. */
  const returnAi = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportReturnAi(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /** Копилот: готовит специалисту то, на что уходит первая пара минут разговора. */
  const loadGrants = async (id: string) => {
    setGrants(await api.supportEngineers(id).catch(() => []));
  };

  /** Заметка специалиста. Отправляется отдельной ручкой — в ленту клиента не попадает. */
  const addNote = async () => {
    const text = noteText.trim();
    if (!conv || !text) return;
    setBusy(true);
    try { setNotes(await api.supportAddNote(conv.id, text)); setNoteText(''); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Заметка не сохранилась'); }
    finally { setBusy(false); }
  };

  /**
   * Перевести обращение в другое состояние.
   *
   * Правила «кто что может» проверяет сервер: отказ приходит словами, и его видно.
   */
  const setStatus = async (to: string) => {
    if (!conv) return;
    setBusy(true); setErr('');
    try { setConv(await api.supportSetStatus(conv.id, to)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  const revokeEngineer = async (engineerId: string) => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportRevokeEngineer(conv.id, engineerId)); await loadGrants(conv.id); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось закрыть доступ'); }
    finally { setBusy(false); }
  };

  const askCopilot = async () => {
    if (!conv) return;
    setBusy(true); setErr('');
    try { setCopilot(await api.supportCopilot(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Помощник не ответил'); }
    finally { setBusy(false); }
  };

  /** Взять разговор себе: человек сразу видит, кто ему отвечает. */
  const takeConversation = async (id: string) => {
    setBusy(true); setErr('');
    try {
      foreignId.current = id;
      setForeign(id);
      setConv(await api.supportJoin(id));
      setView('chat');
      loadQueue();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось взять разговор'); }
    finally { setBusy(false); }
  };

  /** Ответ дежурного — в тот же разговор, что читает человек. */
  const replyAsAgent = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!conv || !body) return;
    setBusy(true); setErr(''); setText('');
    try { setConv(await api.supportReply(conv.id, body)); }
    catch (e) { setText(body); setErr(e instanceof ApiError ? e.message : 'Не отправилось'); }
    finally { setBusy(false); }
  };

  /** «Кажется, решено»: разговор уходит человеку на проверку, а не закрывается. */
  const resolveAsAgent = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportResolve(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /*
    Живой разговор: ответ специалиста должен появляться сам.

    Слушаем всегда, а не только при открытой панели: если человеку ответили, пока
    он работал, кнопка обязана это показать — иначе он ждёт у закрытой двери.
  */
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => { void load(); };
    const events = ['support.message.created', 'support.status.changed', 'support.agent.joined', 'support.resolved',
      // ТЗ-29: итог помощи, согласие на запись, тест, доступ к настройкам
      'support.request.resolution', 'support.recording.consent', 'support.test.offered', 'support.access.requested', 'support.access.changed',
      // ТЗ-34: прогресс инженера и карточки действий — без перезагрузки
      'support.progress', 'support.action.proposed', 'support.action.done', 'support.call.requested', 'support.call.accepted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => { for (const ev of events) socket.off(ev, refresh); };
  }, [load]);

  // Лента всегда на последней реплике: разговор читают с конца.
  useEffect(() => {
    if (!open) return;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, conv?.messages.length, view]);

  // Enter — отправить, Shift/Ctrl+Enter — новая строка, после диктовки тоже (useEnterSend)
  const textEnter = useEnterSend(() => { void (mineConversation ? send() : replyAsAgent()); });
  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!body || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setErr('');
    setText('');
    try {
      // Контекст собираем в момент отправки: важно, где человек был, когда написал.
      const next = await api.supportSend(body, collectSupportContext());
      convRef.current = next;
      setConv(next);
      void load();
    } catch (e) {
      setText(body); // не теряем написанное
      setErr(e instanceof ApiError ? e.message : 'Сообщение не отправилось');
    } finally { setBusy(false); busyRef.current = false; }
  };

  /**
   * Три кнопки над вводом (п. 2.2): текст кнопки — и есть просьба. Вторая ещё и
   * просит созвон: вторая сторона увидит карточку «Присоединиться».
   */
  const quick = async (label: string) => {
    if (!conv || conv.status === 'closed') await send(label);
    if (label === QUICK[1]) await askCallRef.current?.();
  };

  const attach = async (file: File) => {
    setBusy(true); setErr('');
    try {
      const small = await shrinkImage(file);
      setConv(await api.supportAttach(small, text.trim(), mineConversation ? undefined : conv?.id));
      setText('');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Файл не отправился');
    } finally { setBusy(false); }
  };

  const callHuman = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportCallHuman(conv.id)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось позвать'); }
    finally { setBusy(false); }
  };

  const confirm = async (ok: boolean, csat?: number, reason?: string) => {
    if (!conv) return;
    setBusy(true);
    try {
      setConv(await api.supportConfirm(conv.id, ok, csat, reason));
      setLowReason(null);
      void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };

  /**
   * «Вопрос снят»: человек закрывает свой разговор сам.
   *
   * Половина обращений заканчивается тем, что человек разобрался сам. Держать
   * такой разговор открытым до ответа специалиста — значит гонять его за ответом,
   * который уже не нужен.
   */
  const closeMine = async () => {
    if (!conv) return;
    setBusy(true);
    try { setConv(await api.supportClose(conv.id)); void load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось закрыть'); }
    finally { setBusy(false); }
  };

  const reopen = async (id: string) => {
    setBusy(true);
    try {
      setConv(await api.supportReopen(id));
      setView('chat');
      void load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось открыть заново'); }
    finally { setBusy(false); }
  };

  const online = desk?.team.filter((t) => t.online) ?? [];
  // Кто ведёт разговор СЕЙЧАС: участников-специалистов может быть несколько (передавали друг другу).
  const agent = conv?.participants.find((p) => (conv.agentId
    ? String(p.user_id) === String(conv.agentId)
    : p.role === 'agent'));
  /*
    С какой стороны стола сидит человек.

    Раньше сторона выводилась из того, чей это разговор (userId === я). Это ломалось,
    когда один и тот же человек — и клиент, и специалист (техотдел проверяет службу на
    себе): в консоли его же реплики показывались как «Вы», кнопки были клиентские, а
    ответ специалиста в CRM выглядел как своё сообщение. Сторона — это МЕСТО, а не
    личность: в консоли и в чужом разговоре из очереди — специалист, иначе — клиент.
  */
  const agentSide = embedded || (!!foreign && !!desk?.isAgent);
  const mineConversation = !agentSide;
  mineRef.current = mineConversation;
  askCallRef.current = askCall;
  /** Ждём ответа человека о результате — тогда лента уступает место вопросу. */
  const asksResult = conv?.status === 'waiting_user' && !agentSide;
  /** Имя первой линии — из настроек службы; до загрузки панели — нейтральное. */
  const personaName = desk?.persona?.name ?? 'Служба заботы';
  /** Свои ли слова: у клиента — все его реплики, у специалиста — его собственные ответы. */
  const isMine = (m: { kind: string; authorId: string | null }) => (agentSide
    ? m.kind === 'agent' && !!m.authorId && String(m.authorId) === String(user?.id ?? '')
    : m.kind === 'user');
  /** Кто обратился — специалисту в шапке нужен клиент и его организация, а не «Служба заботы». */
  const client = conv?.participants.find((p) => String(p.user_id) === String(conv.userId));
  const clientLine = [client?.full_name, conv?.orgName].filter(Boolean).join(' · ');
  /** Разговор ведёт кто-то другой: взять можно, но стоит знать, у кого забираешь. */
  const heldByOther = !!conv?.agentId && String(conv.agentId) !== String(user?.id ?? '');
  const ctx = describeContext(collectSupportContext());
  /** Контекст клиента для специалиста: где он был, когда написал (собран на его стороне). */
  const clientCtx = !mineConversation && conv?.context
    ? describeContext(conv.context as Parameters<typeof describeContext>[0])
    : [];

  /*
    Островку заботы — кто ведёт разговор, прогресс и последнее входящее: по ним он
    рисует аватар на свёрнутом кружке, полосу и бейдж непрочитанного.
  */
  const lastIncoming = [...(conv?.messages ?? [])].reverse().find((m) => !isMine(m))?.id ?? null;
  const progress: CareProgress | null = conv?.progress && conv.status !== 'closed'
    ? { engineer: conv.progress.engineer, text: conv.progress.text, percent: conv.progress.percent, minutesLeft: conv.progress.minutesLeft }
    : null;
  const infoKey = `${agent?.full_name ?? ''}|${lastIncoming ?? ''}|${progress ? `${progress.percent}|${progress.text}|${progress.minutesLeft}` : ''}`;
  useEffect(() => {
    if (!embedded) onInfo?.({ agent: agent?.full_name ?? null, progress, lastIncoming });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoKey]);

  /** Шторка на телефоне: тянуть вверх — во весь экран, вниз — в кружок (п. 3.1). */
  const drag = useRef<{ y: number } | null>(null);
  const gripDown = (e: React.PointerEvent) => { drag.current = { y: e.clientY }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); };
  const gripUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (dy < -50) setFull(true);
    else if (dy > 60) { if (full) setFull(false); else onMinimize?.(); }
  };

  /** ПК ↔ телефон (п. 3.7): тот же разговор по ссылке, созвон — по ссылке комнаты. */
  const continueElsewhere = async () => {
    if (!conv) return;
    const joinMsg = [...conv.messages].reverse().find((m) => m.kind === 'system' && /Созвон начат — подключайтесь: /.test(m.body ?? ''));
    const join = joinMsg?.body?.split('подключайтесь: ')[1]?.trim();
    const url = `${window.location.origin}/support/${conv.id}`;
    const textOut = join ? `${url}\nСозвон: ${join}` : url;
    try {
      if (navigator.share && window.matchMedia('(max-width: 720px)').matches) await navigator.share({ title: 'Отдел заботы QEVO', url, text: textOut });
      else await navigator.clipboard.writeText(textOut);
      setHandoff(join ? 'Ссылка скопирована: откройте её на другом устройстве — разговор и созвон продолжатся там' : 'Ссылка скопирована: откройте её на другом устройстве — разговор продолжится там');
    } catch {
      setHandoff(textOut);
    }
  };
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches;

  if (!user || user.role === 'client') return null;

  return (
    <>
      {/*
        Кнопки-кружка в углу больше нет: вход в службу заботы — строкой в левой панели,
        над AI Секретарём (просьба заказчика). Кружок висел над полем ввода чатов и
        мешал печатать; строка в панели видна всегда и ничему не мешает.
      */}
      {open && (
        <aside
          className={`support-dock${embedded ? ' support-dock-embedded' : ''}${full ? ' support-dock-full' : ''}${minimized ? ' support-dock-min' : ''}`}
          role="dialog"
          aria-label="Отдел заботы"
          aria-hidden={minimized || undefined}
        >
          {!embedded && (
            <div className="support-grip" onPointerDown={gripDown} onPointerUp={gripUp} onPointerCancel={() => { drag.current = null; }} aria-hidden="true">
              <span />
            </div>
          )}
          <header className="support-head">
            <span className="support-head-mark" aria-hidden="true"><Icon name={mineConversation ? 'support' : 'user'} size={18} /></span>
            <div className="support-head-title">
              {mineConversation ? (
                <>
                  {/* Клиент видит сотрудника по имени — и первую линию, и подключившегося специалиста. */}
                  <b>{agent ? agent.full_name : personaName}</b>
                  <span className="dim support-head-sub">
                    {agent
                      ? 'Специалист на связи'
                      : conv?.status === 'waiting_agent'
                        ? 'Подключаем старшего специалиста'
                        : conv
                          ? 'Служба заботы · на связи'
                          : etaText(desk?.etaSeconds ?? null)}
                    {online.length > 0 && !agent && !conv && <span className="support-online"> · {online.length} на связи</span>}
                  </span>
                </>
              ) : (
                <>
                  {/* Специалист смотрит на клиента: имя, организация, чем занят разговор. */}
                  <b>{clientLine || 'Обращение'}</b>
                  <span className="dim support-head-sub">
                    {conv?.subject}{conv?.statusText ? ` · ${conv.statusText}` : ''}
                    {agent ? (String(agent.user_id) === String(user?.id ?? '') ? ' · ведёте вы' : ` · ведёт ${agent.full_name}`) : ''}
                  </span>
                </>
              )}
            </div>
            {conv && (
              <button
                className="msg-icon"
                onClick={() => void askCall()}
                disabled={busy || !!conv.call}
                title={conv.call
                  ? 'Просьба о созвоне уже отправлена — ждём ответа'
                  : 'Предложить созвон: вторая сторона решит, удобно ли ей сейчас'}
                aria-label="Предложить созвон"
              >
                <Icon name="phone" size={15} />
              </button>
            )}
            {desk?.isAgent && conv && !mineConversation && (
              <button
                className={`msg-icon${tools ? ' active' : ''}`}
                onClick={() => void openTools(conv.id)}
                title="Диагностика, инженер, задача"
                aria-label="Инструменты специалиста"
                aria-expanded={tools}
              >
                <Icon name="settings" size={15} />
              </button>
            )}
            {desk?.isAgent && (
              <button
                className={`msg-icon${view === 'queue' ? ' active' : ''}`}
                onClick={() => setView(view === 'queue' ? 'chat' : 'queue')}
                title="Очередь службы заботы"
                aria-label="Очередь службы заботы"
              >
                <Icon name="inbox" size={15} />
                {queue.some((q) => q.status === 'waiting_agent') && <span className="support-fab-dot" aria-hidden="true" />}
              </button>
            )}
            <button
              className={`msg-icon${view === 'history' ? ' active' : ''}`}
              onClick={() => setView(view === 'history' ? 'chat' : 'history')}
              title="Мои прошлые обращения"
              aria-label="Мои прошлые обращения"
            >
              <Icon name="clock" size={15} />
            </button>
            {!embedded && onMinimize && (
              <button className="msg-icon" onClick={onMinimize} title="Свернуть в кружок — разговор останется с вами" aria-label="Свернуть">
                <Icon name="minimize" size={15} />
              </button>
            )}
            <button
              className="msg-icon"
              onClick={() => { if (foreignId.current) leaveForeign(); setOpen(false); }}
              title="Закрыть"
              aria-label="Закрыть"
            >
              <Icon name="close" size={15} />
            </button>
          </header>

          {/*
            Первый шаг специалиста — взять обращение.

            Кнопка стоит над лентой, а не прячется в очереди: специалист открыл разговор
            и должен сразу видеть, что делать. Пока он не взял, поле ответа внизу тоже
            работает — сервер сам назначит ответившего; но взять явно честнее для
            клиента: он видит имя того, кто ему поможет, до первого ответа.
          */}
          {!mineConversation && conv && conv.status !== 'closed' && String(conv.agentId ?? '') !== String(user?.id ?? '') && (
            <div className="support-take">
              <span className="dim">
                {heldByOther ? `Ведёт ${agent?.full_name ?? 'другой специалист'}` : 'Обращение никто не взял'}
              </span>
              <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void takeConversation(conv.id)}>
                {heldByOther ? 'Взять себе' : 'Взять себе и ответить'}
              </button>
            </div>
          )}
          {/* Записка помощника «что уже пробовали» — только тому, кто работает в разговоре. */}
          {!mineConversation && conv?.handoffNote && (
            <div className="support-handoff">
              <Icon name="info" size={13} /> <span>{conv.handoffNote}</span>
            </div>
          )}

          {/*
            Массовый сбой — первым делом и для всех (разд. 43).

            Человек, у которого «всё сломалось», должен узнать об этом раньше, чем
            напишет: иначе двадцать человек по очереди объясняют одну и ту же аварию.
          */}
          {desk?.incident && (
            <div className="support-incident">
              <Icon name="alert" size={14} />
              <span><b>{desk.incident.title}.</b> {desk.incident.message}</span>
            </div>
          )}

          {/* Живой прогресс инженера (п. 3.6): что делает и сколько осталось */}
          {progress && (
            <div className="support-progress" role="status">
              <span className="support-progress-text">{conv?.progress?.line}</span>
              <span className="support-progress-bar" aria-hidden="true"><span style={{ width: `${progress.percent}%` }} /></span>
            </div>
          )}

          {err && <div className="error-text support-err">{err}</div>}

          {/* Живой инженер и честное ожидание (ТЗ-29): пока специалист не подключился */}
          {mineConversation && view === 'chat' && !agent && (
            <Suspense fallback={null}>
              <ConciergeHead
                compact={!!conv}
                hasConversation={!!conv}
                onHelpNow={() => { if (conv) void callHuman(); else document.querySelector<HTMLTextAreaElement>('.support-dock textarea')?.focus(); }}
              />
            </Suspense>
          )}

          {view === 'queue' ? (
            <div className="support-feed">
              {!queue.length && <p className="dim support-empty">Сейчас никто не ждёт — тишина.</p>}
              {queue.map((q) => (
                <div key={q.id} className="support-history-row">
                  <div className="support-history-head">
                    <b>{q.subject || 'Обращение'}</b>
                    <span className="dim">{stampLabel(q.waitingSince)}</span>
                  </div>
                  <div className="dim support-history-sub">
                    {q.userName} · {q.statusText}
                    {q.agentName ? ` · ведёт ${q.agentName}` : ''}
                  </div>
                  <span className="support-ask-row">
                    <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void openConversation(q.id)}>
                      Открыть
                    </button>
                    {!q.agentName && (
                      <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void takeConversation(q.id)}>
                        Взять себе
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : view === 'history' ? (
            <div className="support-feed">
              {!desk?.history.length && (
                <p className="dim support-empty">Здесь появятся ваши прошлые обращения.</p>
              )}
              {desk?.history.map((h) => (
                <div key={h.id} className="support-history-row">
                  <div className="support-history-head">
                    <b>{h.subject || 'Обращение'}</b>
                    <span className="dim">{new Date(h.createdAt).toLocaleDateString('ru-RU')}</span>
                  </div>
                  <div className="dim support-history-sub">
                    {h.statusText}
                    {h.agentName ? ` · ${h.agentName}` : ''}
                    {h.csat ? ` · оценка ${h.csat}/4` : ''}
                  </div>
                  {h.closedAt && (
                    <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void reopen(h.id)}>
                      Проблема снова появилась
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="support-feed" ref={feedRef}>
                {!conv && (
                  <div className="support-hello">
                    <p><b>Расскажите, что случилось.</b></p>
                    <p className="dim">
                      Ответит {personaName} из службы заботы — она видит, на каком вы экране, и знает систему.
                      Если понадобится, подключит старшего специалиста: повторять ничего не придётся.
                    </p>
                  </div>
                )}
                {feedItems(conv).map((item) => item.type === 'action' ? (
                  /*
                    Карточка действия в 1 тап (п. 3.4) — прямо в ленте, на своём месте по
                    времени. Кнопка — само действие; без неё не происходит ничего (разд. 38).
                  */
                  <div key={`a-${item.a.id}`} className={`support-action${item.a.status === 'done' ? ' done' : ''}${item.a.status === 'declined' || item.a.status === 'undone' ? ' off' : ''}`}>
                    <span className="support-action-text">
                      <Icon name={item.a.status === 'done' ? 'check' : 'zap'} size={13} /> {item.a.preview}
                    </span>
                    {item.a.status === 'proposed' && mineConversation && (
                      <span className="support-action-acts">
                        <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void decideAction(item.a.id, true)}>
                          <Icon name="zap" size={13} /> {item.a.button ?? 'Разрешить'}
                        </button>
                        <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void decideAction(item.a.id, false)}>
                          Не надо
                        </button>
                      </span>
                    )}
                    {item.a.status === 'proposed' && !mineConversation && <span className="dim">ждёт решения клиента</span>}
                    {item.a.status === 'done' && (item.a.undoable ?? item.a.action !== 'project.columns') && (
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void undoAction(item.a.id)}>
                        Вернуть как было
                      </button>
                    )}
                  </div>
                ) : ((m) => (
                  m.kind === 'system' ? (
                    <div key={m.id} className="support-system">
                      {m.authorName ? `${m.authorName} ${m.body}` : m.body}
                    </div>
                  ) : (
                    <div
                      key={m.id}
                      className={`support-msg support-msg-${m.kind}${isMine(m) ? ' support-msg-mine' : ''}`}
                    >
                      <div className="support-msg-who">
                        {isMine(m)
                          ? 'Вы'
                          : m.kind === 'ai'
                            // Клиенту — имя сотрудника; техотделу — то же имя с пометкой, что за ним модель.
                            ? (agentSide ? `${m.authorName ?? personaName} · первая линия (ИИ)` : (m.authorName ?? personaName))
                            : m.authorName ?? (m.kind === 'user' ? 'Клиент' : 'Специалист')}
                        <span className="dim support-msg-time">{stampLabel(m.createdAt)}</span>
                      </div>
                      {m.body && <MessageText text={m.body} className="support-msg-text" />}
                      {/*
                        Файл берём через ручку разговора, а не общую /files/:id.

                        Снимок лежит в организации обратившегося: специалист вендора по
                        общему адресу его не откроет, а по разговору — да.
                      */}
                      {m.fileId && (
                        <a className="support-file" href={apiUrl(`/api/support/desk/${conv?.id}/files/${m.fileId}`)} target="_blank" rel="noreferrer">
                          <Icon name="paperclip" size={13} /> {m.fileName ?? 'файл'}
                        </a>
                      )}
                    </div>
                  )
                ))(item.m))}
              </div>

              {/*
                Просьба о созвоне (04_SUPPORT_HUDDLE §2).

                Карточку видит ВТОРАЯ сторона — та, которую зовут. Отказ стоит рядом с
                согласием и выглядит так же обычно: «сейчас неудобно» должно быть таким
                же простым ответом, как «давайте», иначе люди соглашаются из вежливости.
              */}
              {conv?.call && String(conv.call.byUserId) !== String(user?.id ?? '') && (
                <div className="support-ask">
                  <b>
                    {conv.call.byRole === 'user'
                      ? `${conv.call.byName ?? 'Человек'} просит созвон`
                      : `${conv.call.byName ?? 'Специалист'} предлагает созвониться`}
                  </b>
                  <div className="support-ask-row">
                    <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => void startHuddle()}>
                      Присоединиться
                    </button>
                    <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void declineCall()}>
                      Сейчас неудобно
                    </button>
                  </div>
                </div>
              )}
              {conv?.call && String(conv.call.byUserId) === String(user?.id ?? '') && (
                <div className="support-ask">
                  <span className="dim">Просьба о созвоне отправлена — ждём ответа.</span>
                </div>
              )}

              {conv && (
                <Suspense fallback={null}>
                  <ConciergeCards conv={conv} mine={mineConversation} onChange={setConv} />
                </Suspense>
              )}

              {/*
                «Всё работает?» — единственный способ закрыть разговор.

                Специалист может считать, что починил; знает это только человек
                (разд. 21). Низкая оценка сразу спрашивает причину — иначе цифра
                ничего не объясняет.
              */}
              {asksResult && (
                <div className="support-ask">
                  <b>Всё работает?</b>
                  <span className="dim">
                    Специалист считает, что починил. Закрыть разговор можете только вы.
                  </span>
                  <div className="support-ask-row">
                    <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => setLowReason(0)}>
                      Да, проблема решена
                    </button>
                    <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void confirm(false)}>
                      Нет, нужна помощь
                    </button>
                  </div>
                  {lowReason !== null && (
                    <div className="support-csat">
                      <span className="dim">Как прошла помощь?</span>
                      <div className="support-faces">
                        {FACES.map((f) => (
                          <button
                            key={f.score}
                            className="support-face"
                            title={f.label}
                            disabled={busy}
                            onClick={() => (f.score <= 2 ? setLowReason(f.score) : void confirm(true, f.score))}
                          >
                            {f.face}
                          </button>
                        ))}
                      </div>
                      {!!lowReason && lowReason <= 2 && (
                        <div className="support-reasons">
                          {REASONS.map((r) => (
                            <button key={r} className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void confirm(true, lowReason, r)}>
                              {r}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/*
                Инструменты специалиста: диагностика, инженер, задача.

                Всё, за чем раньше пришлось бы ходить по системе и спрашивать человека:
                где он был, в каком браузере, что за ошибка (разд. 17), — плюс два
                действия, из-за которых обращение обычно и застревает.
              */}
              {tools && conv && (
                <div className="support-tools">
                  <div className="support-tools-head">
                    <b>Диагностика</b>
                    <span className="dim">видно только специалисту</span>
                  </div>

                  {/*
                    Записка помощника — первым делом.

                    Человек уже рассказал боту, что случилось и что пробовал. Первый
                    вопрос живого специалиста «расскажите, что у вас» — ровно та потеря,
                    ради которой эта записка и готовится.
                  */}
                  {conv.handoffNote && (
                    <div className="support-handoff">
                      <b>Что было до вас</b>
                      <span>{conv.handoffNote}</span>
                    </div>
                  )}
                  <dl className="support-diag">
                    <dt>Адрес</dt><dd>{diag?.context?.url ?? '—'}</dd>
                    <dt>Раздел</dt>
                    <dd>
                      {diag?.context?.route ?? '—'}
                      {diag?.context?.entity_type ? ` · ${diag.context.entity_type} #${diag.context.entity_id}` : ''}
                    </dd>
                    <dt>Браузер</dt><dd>{diag?.context?.browser ?? '—'} · {diag?.context?.os ?? '—'}</dd>
                    <dt>Сборка</dt><dd>{diag?.context?.app_version ?? '—'}{diag?.context?.build_id ? ` (${diag.context.build_id})` : ''}</dd>
                    {/* Телефон: приложение или сайт, версия оболочки, модель — первые вопросы к мобильному багу (волна 10) */}
                    {diag?.context?.platform && diag.context.platform !== 'web' && (
                      <>
                        <dt>Где</dt>
                        <dd>
                          {diag.context.platform === 'capacitor' ? `Приложение ${diag.context.native_version ?? ''}`.trim() : 'Сайт в телефоне'}
                          {diag.context.device ? ` · ${diag.context.device}` : ''}
                        </dd>
                      </>
                    )}
                    <dt>Ошибка</dt><dd>{diag?.context?.last_error ?? 'не было'}</dd>
                    <dt>Сеть</dt><dd>{diag?.context?.network ?? '—'}</dd>
                  </dl>
                  <Telemetry ctx={diag?.context ?? null} />
                  <ProgressTool conv={conv} onChange={setConv} />
                  <ProposeTool conv={conv} ctx={diag?.context ?? null} onChange={setConv} />
                  <Suspense fallback={null}>
                    <ConciergeTools
                      conv={conv}
                      failed={((diag?.context as { metadata?: { failedRequests?: [] } } | null)?.metadata?.failedRequests ?? [])}
                      onChange={setConv}
                    />
                  </Suspense>
                  {!!diag?.issues.length && (
                    <div className="support-issues">
                      {diag.issues.map((i) => (
                        <span key={i.taskId} className={`ui-badge ui-badge-neutral${i.closed ? ' badge-muted' : ' badge-info'}`}>
                          Задача #{i.taskId} · {i.closed ? 'закрыта' : 'в работе'}
                        </span>
                      ))}
                    </div>
                  )}
                  {/*
                    Копилот (разд. 41): суть, что проверить, что сказать человеку.

                    Клиенту сам ничего не отправляет — после подключения специалиста ИИ
                    молчит, пока его не попросят. Ответ читает человек, а не машина.
                  */}
                  <div className="support-tools-acts">
                    <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void askCopilot()}>
                      <Icon name="sparkles" size={13} /> Подсказка помощника
                    </button>
                    {/*
                      Режим помощника виден и переключается только здесь.

                      «Копилот» означает, что клиенту он не пишет. Вернуть его — решение
                      специалиста: сам он посреди живого разговора не возвращается.
                    */}
                    {conv.aiMode === 'copilot' ? (
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void returnAi()}>
                        Вернуть помощника в разговор
                      </button>
                    ) : (
                      <span className="ui-badge ui-badge-info">помощник отвечает сам</span>
                    )}
                    {copilot?.known && (
                      <span className="ui-badge ui-badge-warn" title={`Задача #${copilot.known.taskId}`}>
                        похоже на известную: {copilot.known.title}
                      </span>
                    )}
                  </div>
                  {copilot?.summary && <div className="support-copilot">{copilot.summary}</div>}

                  <div className="support-tools-acts">
                    <OptionSelect
                      className="input"
                      value=""
                      disabled={busy}
                      onChange={(e) => { void addEngineer(e.target.value); e.currentTarget.value = ''; }}
                      aria-label="Подключить инженера"
                    >
                      <option value="">Подключить инженера…</option>
                      {people
                        .filter((p) => !conv.participants.some((x) => String(x.user_id) === p.id))
                        .map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
                    </OptionSelect>
                    <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void createBug()}>
                      <Icon name="alert" size={13} /> Завести задачу
                    </button>
                  </div>

                  {/*
                    Куда двигать обращение.

                    Состояние должно отвечать на вопрос «что с ним сейчас» без чтения
                    переписки: работа инженера и ожидание ответа клиента выглядели
                    одинаково — «в работе». Кнопки показываем те, что разрешены из
                    текущего состояния; остальное сервер всё равно отклонит словами.
                  */}
                  <div className="support-tools-acts">
                    {conv.status !== 'engineer_escalated' && conv.status !== 'fix_in_progress' && (
                      <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void setStatus('engineer_escalated')}>
                        Передал инженерам
                      </button>
                    )}
                    {(conv.status === 'engineer_escalated' || conv.status === 'fix_in_progress') && (
                      <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void setStatus(conv.status === 'fix_in_progress' ? 'in_progress' : 'fix_in_progress')}>
                        {conv.status === 'fix_in_progress' ? 'Вернуть в работу' : 'Чиним'}
                      </button>
                    )}
                    {conv.status !== 'waiting_reply' && (
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void setStatus('waiting_reply')}>
                        Жду ответа
                      </button>
                    )}
                  </div>

                  {/*
                    Внутренние заметки.

                    Отдельной лентой и другим цветом, чтобы никто не перепутал их с
                    ответом клиенту. Живут в своей таблице и отдаются своей ручкой —
                    «сообщение с флагом внутреннее» однажды уехало бы наружу.
                  */}
                  <div className="support-notes">
                    <div className="support-tools-head">
                      <b>Заметки для своих</b>
                      <span className="dim">клиент их не видит</span>
                    </div>
                    {notes.map((n) => (
                      <div key={n.id} className="support-note">
                        <span className="dim">{n.authorName} · {stampLabel(n.createdAt)}</span>
                        <span>{n.body}</span>
                      </div>
                    ))}
                    <div className="support-tools-acts">
                      <input
                        className="input"
                        value={noteText}
                        placeholder="Что важно знать тому, кто продолжит"
                        onChange={(e) => setNoteText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addNote(); } }}
                      />
                      <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy || !noteText.trim()} onClick={() => void addNote()}>
                        Записать
                      </button>
                    </div>
                  </div>

                  {/*
                    Лента событий: вся жизнь обращения одним экраном.

                    Собирается из уже записанного, а не из отдельного журнала: тот
                    разошёлся бы с фактами при первой же ошибке.
                  */}
                  {!!timeline?.events.length && (
                    <div className="support-timeline">
                      <div className="support-tools-head">
                        <b>Что происходило</b>
                        {timeline.reopens > 0 && <span className="dim">открывали заново: {timeline.reopens}</span>}
                      </div>
                      {timeline.events.map((e, i) => (
                        <div key={`${e.kind}-${i}`} className="support-tl-row">
                          <span className="dim">{stampLabel(e.at)}</span>
                          <span>{e.text}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/*
                    Доступ инженеров — со сроком и кнопкой «Закрыть».

                    Право читать чужую переписку выдаётся на время эскалации, а не
                    навсегда. Специалист должен видеть, кому сейчас открыт разговор, —
                    иначе отозвать доступ не придёт в голову никому.
                  */}
                  {!!grants.length && (
                    <div className="support-grants">
                      {grants.map((g) => (
                        <span key={g.engineerId} className={`support-grant${g.live ? ' live' : ''}`}>
                          <Icon name="user" size={12} /> {g.name}
                          <span className="dim">
                            {g.live
                              ? ` до ${new Date(g.expiresAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                              : ' доступ закрыт'}
                          </span>
                          {g.live && (
                            <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void revokeEngineer(g.engineerId)}>
                              Закрыть
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mineConversation && (!conv || conv.status === 'closed') && (
                <div className="support-quick" aria-label="Чем помочь">
                  {QUICK.map((q, i) => (
                    <button key={q} type="button" className="support-quick-btn" disabled={busy} onClick={() => void quick(q)}>
                      <Icon name={i === 0 ? 'upload' : i === 1 ? 'video' : 'sparkles'} size={14} /> {q}
                    </button>
                  ))}
                </div>
              )}
              <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} className="support-voice" />
              <div className="support-compose">
                {/* Голос первым (п. 2.3, 3.2): крупная кнопка; зажал — говоришь, отпустил — ушло */}
                <button
                  type="button"
                  className={`support-mic${voice.recording ? ' recording' : ''}`}
                  onPointerDown={(e) => { if (e.button === 0) micDown(); }}
                  onPointerUp={micUp}
                  onPointerLeave={() => { if (press.current !== null && voice.recording) micUp(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); voice.toggle(); } }}
                  onContextMenu={(e) => e.preventDefault()}
                  disabled={busy || voice.transcribing}
                  title={voice.recording ? 'Отпустите — отправим; или нажмите ещё раз, чтобы остановить' : 'Зажмите и говорите — отпустите, и сообщение уйдёт. Короткое нажатие — запись с остановкой'}
                  aria-label={voice.recording ? 'Остановить запись' : 'Сказать голосом'}
                >
                  <Icon name={voice.recording ? 'stop' : 'mic'} size={20} />
                </button>
                <label className="chat-tool" title="Приложить снимок экрана или файл">
                  <Icon name="paperclip" size={17} />
                  <input
                    type="file"
                    hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.currentTarget.value = ''; }}
                  />
                </label>
                <textarea
                  className="input"
                  value={text}
                  rows={mineConversation && !text ? 2 : 1}
                  placeholder={mineConversation ? 'Зажмите микрофон и скажите своими словами (5 сек) или скиньте список задач — остальное сделаем мы...' : 'Ответ клиенту… (Enter — отправить)'}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={textEnter.onKeyDown}
                  onCompositionEnd={textEnter.onCompositionEnd}
                />
                <button
                  className="chat-send"
                  disabled={busy || !text.trim()}
                  onClick={() => void (mineConversation ? send() : replyAsAgent())}
                  title="Отправить"
                  aria-label="Отправить"
                >
                  <Icon name="send" size={17} />
                </button>
              </div>

              {handoff && <div className="dim support-handoff-note" role="status">{handoff}</div>}
              <footer className="support-foot">
                {/* Человек вправе знать, что уходит вместе с сообщением (разд. 50). */}
                {mineConversation ? (
                  <span className="dim support-ctx" title="Эти данные уйдут специалисту вместе с сообщением">
                    <Icon name="info" size={12} /> {ctx.join(' · ')}
                  </span>
                ) : (
                  <span className="dim support-ctx" title="Где был клиент, когда написал">
                    <Icon name="info" size={12} /> {clientCtx.length ? clientCtx.join(' · ') : 'контекст клиента не передан'}
                  </span>
                )}
                {conv && mineConversation && conv.status !== 'closed' && (
                  <button
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    onClick={() => void continueElsewhere()}
                    title="Тот же разговор и созвон — на другом устройстве, без повторных объяснений"
                  >
                    <Icon name={narrow ? 'monitor' : 'phone'} size={13} /> {narrow ? 'Продолжить на компьютере' : 'Продолжить на телефоне'}
                  </button>
                )}
                {conv && mineConversation && !conv.agentId && conv.status !== 'closed' && (
                  <button
                    className="ui-btn ui-btn-outline ui-btn-sm support-human"
                    disabled={busy}
                    onClick={() => void callHuman()}
                    title="Подключить старшего специалиста к этому разговору"
                  >
                    <Icon name="user" size={13} /> Позвать старшего специалиста
                  </button>
                )}
                {conv && mineConversation && conv.status !== 'closed' && !asksResult && (
                  <button
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    disabled={busy}
                    onClick={() => void closeMine()}
                    title="Закрыть разговор: вопрос больше не нужен. Если проблема вернётся — откроете заново."
                  >
                    <Icon name="check" size={13} /> Вопрос снят
                  </button>
                )}
                {conv && !mineConversation && conv.status !== 'closed' && conv.status !== 'waiting_user' && (
                  <button
                    className="ui-btn ui-btn-outline ui-btn-sm support-human"
                    disabled={busy}
                    onClick={() => void resolveAsAgent()}
                    title="Человек получит вопрос «Всё работает?» и закроет разговор сам"
                  >
                    <Icon name="check" size={13} /> Решено — спросить человека
                  </button>
                )}
              </footer>
            </>
          )}
        </aside>
      )}
    </>
  );
}

type FeedItem =
  | { type: 'message'; at: string; m: SupportConversation['messages'][number] }
  | { type: 'action'; at: string; a: SupportConversation['actions'][number] };

/** Лента целиком: реплики и карточки действий — по времени, карточка на своём месте. */
function feedItems(conv: SupportConversation | null): FeedItem[] {
  if (!conv) return [];
  const items: FeedItem[] = [
    ...conv.messages.map((m) => ({ type: 'message' as const, at: m.createdAt, m })),
    ...conv.actions.filter((a) => a.status !== 'declined').map((a) => ({ type: 'action' as const, at: a.createdAt, a })),
  ];
  // карточка встаёт сразу после системной строки «предлагает: …» — сортировка устойчивая
  return items.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
}

type Ctx = Record<string, unknown> & { metadata?: { telemetry?: Record<string, unknown> } };

/**
 * «Телеметрия» (ТЗ-34, 3.5): экран, окно, ориентация и открытая карточка — то, о чём
 * раньше просили скриншот. Видит только специалист.
 */
function Telemetry({ ctx }: { ctx: Ctx | null }) {
  const t = (ctx?.metadata?.telemetry ?? {}) as { screen?: string; viewport?: string; orientation?: string; dpr?: number; entityTitle?: string };
  const entity = ctx?.entity_type ? `${ctx.entity_type === 'task' ? 'задача' : ctx.entity_type === 'project' ? 'проект' : String(ctx.entity_type)} #${String(ctx.entity_id ?? '')}` : '';
  return (
    <div className="support-telemetry">
      <div className="support-tools-head"><b>Телеметрия</b><span className="dim">скриншоты не нужны</span></div>
      <dl className="support-diag">
        <dt>Экран</dt><dd>{t.screen ?? '—'}{t.dpr ? ` · ×${t.dpr}` : ''}</dd>
        <dt>Окно</dt><dd>{t.viewport ?? '—'}{t.orientation ? ` · ${t.orientation === 'portrait' ? 'вертикально' : 'горизонтально'}` : ''}</dd>
        <dt>Карточка</dt><dd>{entity || '—'}{t.entityTitle ? ` «${t.entityTitle}»` : ''}</dd>
      </dl>
    </div>
  );
}

/**
 * Живой прогресс (ТЗ-34, 3.6): «что делаю», проценты и минуты. Клиент видит полосу в
 * окне и на свёрнутом кружке, на Android — в уведомлении; на 100% — тихий push «Готово».
 */
function ProgressTool({ conv, onChange }: { conv: SupportConversation; onChange: (c: SupportConversation) => void }) {
  const [text, setText] = useState(conv.progress?.text ?? '');
  const [percent, setPercent] = useState(String(conv.progress?.percent ?? 0));
  const [minutes, setMinutes] = useState(conv.progress?.minutesLeft == null ? '' : String(conv.progress.minutesLeft));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async (p: { text: string; percent: number; minutesLeft: number | null }) => {
    setBusy(true); setErr('');
    try { onChange(await api.supportSetProgress(conv.id, p)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };
  const now = () => ({ text, percent: Number(percent) || 0, minutesLeft: minutes === '' ? null : Number(minutes) });
  return (
    <div className="support-telemetry">
      <div className="support-tools-head"><b>Что делаю</b><span className="dim">клиент видит полосу и строку</span></div>
      <input className="input" value={text} maxLength={160} placeholder="переносит ваши 120 задач и создает папки проектов" onChange={(e) => setText(e.target.value)} aria-label="Что делаю" />
      <div className="support-tools-acts">
        <label className="support-num"><input className="input" type="number" min={0} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} aria-label="Готово, %" /> %</label>
        <label className="support-num"><input className="input" type="number" min={0} max={1440} value={minutes} placeholder="—" onChange={(e) => setMinutes(e.target.value)} aria-label="Осталось минут" /> мин</label>
        <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy || !text.trim()} onClick={() => void save(now())}>Показать клиенту</button>
        <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !text.trim()} onClick={() => { setPercent('100'); void save({ ...now(), percent: 100, minutesLeft: 0 }); }}>Готово 100%</button>
        {conv.progress && <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => { setText(''); void save({ text: '', percent: 0, minutesLeft: null }); }}>Снять</button>}
      </div>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

const ACTION_KINDS: { kind: string; label: string; entity: string; value?: string }[] = [
  { kind: 'meetings.autoprotocol', label: 'Включить автопротокол созвонов', entity: '' },
  { kind: 'import.confirm', label: 'Подтвердить импорт из приложенной таблицы', entity: 'file' },
  { kind: 'task.deadline', label: 'Поставить срок задаче', entity: 'номер задачи', value: 'date' },
  { kind: 'task.assignee', label: 'Назначить исполнителя', entity: 'номер задачи', value: 'номер сотрудника' },
  { kind: 'task.project', label: 'Перенести задачу в проект', entity: 'номер задачи', value: 'номер проекта' },
  { kind: 'project.columns', label: 'Вернуть колонки проекта', entity: 'номер проекта' },
];

/**
 * «Предложить действие» (ТЗ-34, 3.4): карточка с одной кнопкой уходит в ленту клиента.
 * Без его нажатия не происходит ничего; что именно случится — написано на карточке.
 */
function ProposeTool({ conv, ctx, onChange }: { conv: SupportConversation; ctx: Ctx | null; onChange: (c: SupportConversation) => void }) {
  const [kind, setKind] = useState('meetings.autoprotocol');
  const def = ACTION_KINDS.find((k) => k.kind === kind) ?? ACTION_KINDS[0];
  const files = conv.messages.filter((m) => m.fileId && /\.(csv|tsv|txt|xlsx|xls)$/i.test(m.fileName ?? ''));
  const [entity, setEntity] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    // номер открытой у клиента карточки — подсказкой: чаще всего речь о ней
    const t = ctx?.entity_type === (def.entity === 'номер проекта' ? 'project' : 'task') ? String(ctx?.entity_id ?? '') : '';
    setEntity(def.entity === 'file' ? String(files[files.length - 1]?.fileId ?? '') : def.entity ? t : 'me');
    setValue('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const propose = async () => {
    setBusy(true); setErr('');
    const v = def.value === 'date' ? (value ? new Date(value).toISOString() : null) : value.trim() || null;
    try { onChange(await api.supportProposeAction(conv.id, kind, entity || 'me', v)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось предложить'); }
    finally { setBusy(false); }
  };
  return (
    <div className="support-telemetry">
      <div className="support-tools-head"><b>Предложить действие</b><span className="dim">клиент решит одним нажатием</span></div>
      <OptionSelect className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Какое действие">
        {ACTION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </OptionSelect>
      <div className="support-tools-acts">
        {def.entity === 'file' ? (
          <OptionSelect className="input" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Какой файл">
            <option value="">{files.length ? 'Какой файл?' : 'Клиент ещё не приложил таблицу'}</option>
            {files.map((m) => <option key={m.id} value={String(m.fileId)}>{m.fileName}</option>)}
          </OptionSelect>
        ) : def.entity ? (
          <input className="input" value={entity} placeholder={def.entity} onChange={(e) => setEntity(e.target.value)} aria-label={def.entity} />
        ) : null}
        {def.value && (
          <input className="input" type={def.value === 'date' ? 'datetime-local' : 'text'} value={value} placeholder={def.value} onChange={(e) => setValue(e.target.value)} aria-label="Значение" />
        )}
        <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || (!!def.entity && !entity)} onClick={() => void propose()}>
          <Icon name="zap" size={13} /> Предложить
        </button>
      </div>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
