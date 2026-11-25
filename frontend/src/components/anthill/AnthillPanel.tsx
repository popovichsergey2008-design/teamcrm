import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QevoBotMark } from '../QevoBotMark';
import { Icon } from '../Icon';
import { RichText } from '../RichText';
import { VoiceStatus } from '../VoiceStatus';
import { api, ApiError } from '../../lib/api';
import type { AnthillAction, AnthillAttachment, AnthillButton, AnthillContext, AnthillMessage, AnthillSession, AnthillSkill, AnthillSource } from '../../lib/api';
import { shrinkImage } from '../../lib/image-shrink';
import './anthill-attach.css';
import { Lightbox } from '../LightboxLazy';
import { navigate } from '../../lib/router';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useHoldToTalk } from '../../hooks/useHoldToTalk';
import { openTarget, resolveOpen } from './open-command';
import { askFor, INTENT_LABEL, type IntentKind } from '../../lib/voice-intent';
import { stickersApi, stickersChanged } from '../../lib/stickers-api';
import { stampLabel } from '../../lib/chat-text';

/*
  Вкладки кроме «Разговора» открывают редко — их код грузится по первому щелчку,
  а не вместе с приложением: так первый экран не платит за настройки бота.
*/
/** Черновик вопроса боту — в общем хранилище черновиков переписки, как у чата `anthill`. */
const BOT_DRAFT_KEY = 'chat:anthill';

/** Главная кнопка карточки — словами действия (#4893, п. 4): «Включить», «Поставить и пригласить». */
const CONFIRM_LABEL: Record<string, string> = {
  create_scheduled_task: 'Включить', create_event: 'Поставить и пригласить', send_message: 'Отправить',
  mail_send: 'Отправить', create_reminder: 'Напомнить', add_comment: 'Отправить',
};
// #5035: вкладки «Что умеет бот», «Автопилоты» и экран настроек — своими кусками
const BotServices = lazy(() => import('./BotServices'));
const ServiceAsk = lazy(() => import('./BotServices').then((m) => ({ default: m.ServiceAsk })));
const BotPilots = lazy(() => import('./BotPilots'));
const BotSettings = lazy(() => import('./BotSettings'));
const BotMatrix = lazy(() => import('./BotMatrix').then((m) => ({ default: m.BotMatrix })));
import type { Service } from './bot-services';
import './bot-v3.css';
// #4893: стартовый экран, каталог и предпросмотр — своим куском, первый экран за них не платит
const BotStart = lazy(() => import('./BotStart'));
const BotSchedule = lazy(() => import('./BotStart').then((m) => ({ default: m.ScheduleFromAnswer })));
const MailConnectCard = lazy(() => import('../mail/MailConnectCard').then((m) => ({ default: m.MailConnectCard })));
import { useAuth } from '../../state/auth';
import { getSocket } from '../../lib/socket';
import { showNotification, showToast } from '../../lib/notifications';
import { useStickyCheck } from '../../lib/sticky-checks';
import { confirmAction } from '../ui/dialog';
import { DropdownMenu, MenuItem, MenuSeparator } from '../ui/dropdown-menu';
import { botApi } from './bot-api';
import { useEnterSend } from '../../hooks/useEnterSend';
import { feedback } from '../../lib/feedback';
import { readDraft, writeDraft } from '../../lib/chat-drafts';
import { openSupport } from '../support/SupportDock';

const CONTEXT_LABEL: Record<AnthillContext['type'], string> = {
  task: 'задача', project: 'проект', chat: 'чат', meeting: 'мит',
};
/** #5008: какие карточки можно «переиграть» в другое действие. */
const KIND_OF_TOOL: Record<string, IntentKind> = {
  create_task: 'task', create_event: 'event', send_message: 'message', create_sticker: 'sticker', create_reminder: 'sticker',
};

const SOURCE_ICON: Record<AnthillSource['kind'], 'check-circle' | 'chat' | 'record' | 'board' | 'link' | 'building'> = {
  client: 'building',
  task: 'check-circle', message: 'chat', chat: 'chat', meeting: 'record', project: 'board', web: 'link',
};
/** Почему ответ не подошёл: короткий список вместо свободного поля — иначе не заполняют. */
const REASONS: { key: string; label: string }[] = [
  { key: 'inaccurate', label: 'неточно' },
  { key: 'not_found', label: 'не нашёл данные' },
  { key: 'invented', label: 'придумал факт' },
  { key: 'wrong_context', label: 'не тот контекст' },
  { key: 'wording', label: 'плохая формулировка' },
  { key: 'other', label: 'другое' },
];
/** Причины для оценки действия (ТЗ-18, §22): что именно бот сделал не так. */
const ACTION_REASONS: { key: string; label: string }[] = [
  { key: 'wrong_person', label: 'не тот человек' },
  { key: 'wrong_time', label: 'не то время' },
  { key: 'wrong_tone', label: 'не тот тон' },
  { key: 'wrong_document', label: 'не тот документ' },
  { key: 'should_not', label: 'не надо было выполнять' },
  { key: 'other', label: 'другое' },
];
type Live = { status: string; text: string; sources: AnthillSource[] };

/**
 * QEVO Bot — персональный AI-помощник (ТЗ-6, MVP 1).
 *
 * Одно окно на три места: поверх CRM из Chat Bar, во весь экран в мессенджере и
 * в списке чатов отдельным собеседником. Внутри — переписка: вопрос, этапы работы
 * («ищу задачи…»), ответ потоком со ссылками на первоисточники и карточка действия,
 * которая ждёт «Создать». Сам агент ничего не меняет — это правило ТЗ, и оно же
 * единственная причина, по которой ему вообще можно доверить запись.
 */
/** Ответ дольше этого — сигнал «готово» (человек успел переключиться). */

/** Последний открытый разговор с QEVO Bot — на этом устройстве (вернулись — он и открыт). */
const LAST_SESSION_KEY = 'qevo.bot.session';
function rememberSession(id: string) { try { localStorage.setItem(LAST_SESSION_KEY, id); } catch { /* без хранилища — откроем самый свежий */ } }
function lastSession(): string | null { try { return localStorage.getItem(LAST_SESSION_KEY); } catch { return null; } }
/** #5035, п. 3: последний разговор открывается, если ему меньше 2 часов; иначе — стартовый экран. */
const RESUME_MS = 2 * 3600_000;

export function AnthillPanel({ context, onClose, onBack, fullscreen, onFullscreen, session }: {
  /** Открыть этот разговор: `/chat/anthill/thread/:id` из уведомления (#4665). */
  session?: string | null;
  /** Что открыто у человека под окном — уходит ответом на «о чём речь». */
  context?: AnthillContext | null;
  onClose?: () => void;
  /** Телефон: «назад» к списку чатов — иначе из бота было не выйти в другие чаты. */
  onBack?: () => void;
  fullscreen?: boolean;
  onFullscreen?: () => void;
}) {
  const [sessions, setSessions] = useState<AnthillSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AnthillMessage[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  /*
    #4790: написанное или надиктованное, но не отправленное, переживает уход в другой
    раздел и закрытие окна — черновиком под ключом чата бота (`chat:anthill`): так его
    видит и раздел «Черновики» в сайдбаре. Отправил — стёрся.
  */
  const [draft, setDraft] = useState(() => readDraft(BOT_DRAFT_KEY));
  useEffect(() => { writeDraft(BOT_DRAFT_KEY, draft); }, [draft]);
  const [useCtx, setUseCtx] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Скриншот из ответа — крупно, по щелчку (как вложения в чатах). */
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [votes, setVotes] = useState<Record<string, 1 | -1>>({});
  /** Карточка, открытая на правку: одна за раз — их и бывает одна. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Разговор · Задачи · Навыки · Память (ТЗ-6, MVP 2): вкладки одного помощника. */
  const [tab, setTab] = useState<'chat' | 'services' | 'pilots'>('chat');
  /** «⋯ → Настройки бота» — отдельный экран (п. 7). */
  const [screen, setScreen] = useState<'main' | 'settings'>('main');
  /** Услуга из вкладки «Что умеет бот» — карточкой в чате, без отправки (п. 5). */
  const [ask, setAsk] = useState<Service | null>(null);
  const [matrix, setMatrix] = useState(false);
  const [histQ, setHistQ] = useState('');
  /** Пока бот грузится — индикатор, а не пустой экран (п. 9). */
  const [booting, setBooting] = useState(true);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setCompact(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  /** Что подключено — статусы групп услуг (почта, интернет по тарифу). */
  const [conn, setConn] = useState({ mail: false, calendar: false, web: false });
  useEffect(() => {
    void botApi.start().then((s) => setConn({ mail: !!s.connections.mail, calendar: !!s.connections.calendar, web: !!s.web })).catch(() => undefined);
  }, []);
  /**
   * «Глубокий анализ» (ТЗ-6, разд. 25).
   *
   * Отдельным переключателем, а не догадкой по вопросу: разбор идёт минуту и стоит
   * заметно дороже обычного ответа — решать, нужен ли он, должен человек.
   */
  const [deep, setDeep] = useStickyCheck('anthill.deep', false);
  /** Быстрые ответы звучат от имени компании — их заводит руководство (разд. 38). */
  const { user } = useAuth();
  const canManage = user?.role === 'owner' || user?.role === 'manager';
  /**
   * Навык, выбранный руками.
   *
   * По умолчанию агент подбирает его сам — так и задумано в ТЗ. Но когда человек
   * знает, чего хочет («сделай именно релизный отчёт»), спорить с ним не нужно.
   */
  const [skill, setSkill] = useState<AnthillSkill | null>(null);
  const [err, setErr] = useState('');
  // #4893, п. 2: сценарию нужна почта — карточка «Яндекс / Google / Mail.ru» с исходной просьбой
  const [mailCard, setMailCard] = useState<{ resume?: string } | null>(null);
  // п. 4: «Присылать это каждый будний день в 9:00?» — предпросмотр расписания
  const [scheduleAsk, setScheduleAsk] = useState<Extract<AnthillButton, { kind: 'schedule' }> | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const busy = live !== null;
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Вложения к вопросу (#4726): скриншот, фото, документ. Сервер читает файл сразу —
   * к отправке у нас уже текст, и сам вопрос не ждёт распознавания.
   */
  const [att, setAtt] = useState<{ key: number; name: string; data?: AnthillAttachment; error?: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const reading = att.some((a) => !a.data && !a.error);
  const addFiles = (files: File[]) => {
    for (const raw of files.slice(0, Math.max(0, 5 - att.length))) {
      const key = Date.now() + Math.random();
      setAtt((list) => [...list, { key, name: raw.name || 'скриншот.png' }]);
      void shrinkImage(raw).then((f) => api.anthillAttach(f))
        .then((data) => setAtt((list) => list.map((a) => (a.key === key ? { ...a, data } : a))))
        .catch((e) => setAtt((list) => list.map((a) => (a.key === key
          ? { ...a, error: e instanceof ApiError ? e.message : 'Не удалось прочитать файл' } : a))));
    }
  };

  const ctxArg = useMemo(
    () => (useCtx && context ? { type: context.type, id: String(context.id) } : null),
    [useCtx, context],
  );

  /*
    Как называется то, что открыто.

    Наверх приходит только тип и номер — страница о своём содержимом ничего не
    сообщает. «Проект №130» человеку не говорит ничего, поэтому имя спрашиваем сами
    и показываем его; не ответили — остаётся номер, это лучше пустоты.
  */
  const [ctxName, setCtxName] = useState<string | null>(null);
  useEffect(() => {
    setCtxName(context?.title ?? null);
    if (!context || context.title) return;
    let alive = true;
    const set = (name?: string | null) => { if (alive && name) setCtxName(name); };
    if (context.type === 'task') api.taskBrief(context.id).then((t) => set(t.title)).catch(() => undefined);
    else if (context.type === 'project') api.listProjects().then((list) => set(list.find((p) => String(p.id) === String(context.id))?.name)).catch(() => undefined);
    return () => { alive = false; };
  }, [context]);

  const loadSessions = useCallback(() => {
    api.anthillSessions().then(setSessions).catch(() => undefined);
  }, []);
  useEffect(() => loadSessions(), [loadSessions]);

  const openSession = async (id: string) => {
    setSessionId(id); setHistoryOpen(false); setErr(''); setAsk(null); setBooting(false);
    rememberSession(id);
    try { setMessages(await api.anthillMessages(id)); } catch { setMessages([]); }
  };

  /*
    Переписка не пропадает (заказчик: «стоит выйти — и всё пропадает»): разговоры и так
    хранились на сервере, но окно каждый раз открывалось пустым. Теперь — последний
    открытый разговор (или самый свежий), а «Новый разговор» начинает чистый.
  */
  useEffect(() => {
    if (session) { void openSession(session); return; }
    let alive = true;
    api.anthillSessions().then((list) => {
      if (!alive) return;
      const withMessages = list.filter((x) => x.messages > 0);
      const last = lastSession();
      const pick = withMessages.find((x) => String(x.id) === last) ?? withMessages[0];
      // свежий (меньше 2 часов) — открываем; иначе — стартовый экран
      if (pick && Date.now() - new Date(pick.updatedAt).getTime() < RESUME_MS) void openSession(String(pick.id));
    }).catch(() => undefined).finally(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const fresh = useCallback(async () => {
    // открытый разговор ещё пуст — он и есть «новый»: не плодим пустые вкладки
    if (sessionId && messages.length === 0 && !live) { inputRef.current?.focus(); return sessionId; }
    const s = await api.anthillStart(ctxArg);
    setSessionId(String(s.id)); setMessages([]); setHistoryOpen(false); setErr('');
    rememberSession(String(s.id));
    loadSessions();
    return String(s.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxArg, loadSessions, sessionId, messages.length, live]);

  /*
    Регулярная задача отработала.

    Открывать её нитку силой нельзя — человек может быть в середине разговора,
    поэтому просто обновляем список задач: вкладка «Задачи» покажет свежий
    результат, а сам отчёт уже пришёл в «Заметки».
  */
  useEffect(() => {
    const socket = getSocket();
    const done = (p: { title?: string }) => {
      loadSessions();
      // Человек мог давно уйти из агента: без сигнала об отчёте он узнает, только
      // если сам заглянет. Отчёт уже лежит в «Заметках» — сюда даём короткий знак.
      showToast({ kind: 'saved', title: 'QEVO-бот: автопилот выполнен', body: p?.title ?? 'Отчёт готов и ждёт в «Заметках»' });
      showNotification('QEVO-бот', `${p?.title ?? 'Автопилот'} — отчёт готов`);
    };
    socket.on('anthill.task.done', done);
    return () => { socket.off('anthill.task.done', done); };
  }, [loadSessions]);

  // Лента вниз на каждый кусок ответа: его читают с конца, пока он печатается.
  // пустой разговор — быстрый старт читается сверху, ленту не мотаем
  useEffect(() => { const el = feedRef.current; if (el && (messages.length || live)) el.scrollTop = el.scrollHeight; }, [messages, live]);

  // Enter — отправить, Shift/Ctrl+Enter — новая строка, после диктовки тоже (useEnterSend)
  const draftEnter = useEnterSend(() => { void send(draft); });
  const send = async (text: string) => {
    const ready = att.flatMap((a) => (a.data ? [a.data] : []));
    // только файл без слов — тоже вопрос: «посмотри, что тут»
    const question = text.trim() || (ready.length ? 'Посмотри вложение: что на нём и что с этим делать?' : '');
    if (!question || busy || reading) return;
    setErr('');
    // #5005: «открой календарь / задачу 5005 / проект QEVO» — переходим сразу, без модели
    const target = ready.length ? null : openTarget(question);
    if (target) {
      const r = await resolveOpen(target, user?.role ?? 'member').catch(() => null);
      if (r) {
        const now = new Date().toISOString();
        setDraft('');
        setMessages((prev) => [...prev,
          { id: `me-${Date.now()}`, role: 'user', content: question, citations: [], createdAt: now, action: null },
          { id: `nav-${Date.now()}`, role: 'assistant', content: 'error' in r ? r.error : `Открываю ${r.title}.`, citations: [], createdAt: now, action: null },
        ]);
        if (!('error' in r)) { navigate(r.route); onClose?.(); }
        return;
      }
    }
    let id: string;
    try { id = sessionId ?? await fresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось начать разговор'); return; }
    setDraft('');
    setAtt([]);
    const named = ready.map((a) => `📎 ${a.name}`).join('\n');
    setMessages((prev) => [...prev, {
      id: `me-${Date.now()}`, role: 'user', content: named ? `${question}\n${named}` : question, citations: [],
      createdAt: new Date().toISOString(), action: null,
    }]);

    const acc: Live = { status: 'Думаю…', text: '', sources: [] };
    const show = () => setLive({ ...acc });
    show();
    let pending: { id: string; tool: string; preview: string; fields?: AnthillAction['fields']; values?: Record<string, string> } | null = null;
    let landed = false;
    let buttons: AnthillButton[] = [];
    const steps: AnthillMessage[] = [];
    const land = (messageId: string) => {
      if (landed) return;
      landed = true;
      setMessages((prev) => [...prev, {
        id: messageId, role: 'assistant', content: acc.text, citations: acc.sources,
        createdAt: new Date().toISOString(),
        action: pending
          ? { id: pending.id, tool: pending.tool, status: 'pending', output: null, fields: pending.fields ?? [], values: pending.values ?? {} }
          : null,
        buttons,
      }, ...steps]);
    };

    const run = api.anthillAsk(id, question, ctxArg, skill ? skill.id : null, deep, {
      onStatus: (t) => { acc.status = t; show(); },
      onDelta: (t) => { acc.text += t; acc.status = ''; show(); },
      onSources: (s) => { acc.sources = s; show(); },
      onAction: (a) => { pending = a; },
      onButtons: (b) => { buttons = b; },
      // шаги прогона встают после вступления — копим, пока вступление не легло в ленту
      onStep: (s) => {
        steps.push({
          id: s.message.id, role: 'assistant', content: s.message.content, citations: [],
          createdAt: new Date().toISOString(), action: s.message.action,
        });
      },
      onDone: (d) => {
        land(String(d.messageId));
        // Один сигнал на ответ, не на каждый кусок потока (ТЗ-23, §40–41).
        feedback('ai.completed');
      },
      onError: (m) => setErr(m || 'Не удалось получить ответ. Попробуйте снова.'),
    }, ready);
    stopRef.current = run.stop;
    await run.finished;
    stopRef.current = null;
    // Остановили на середине — набранное остаётся на экране: оно уже сохранено на сервере.
    if (acc.text || pending) land(`part-${Date.now()}`);
    setLive(null);
    loadSessions();
  };
  /** Заготовка в строку ввода: человек дописывает и отправляет сам. */
  const fillDraft = (t: string) => { setDraft(t); window.setTimeout(() => inputRef.current?.focus(), 0); };
  /** Кнопка следующего шага (#4893, п. 4). Пишущее бот всё равно покажет карточкой. */
  const onNext = async (messageId: string, b: AnthillButton) => {
    if (b.kind === 'prompt') { void send(b.prompt); return; }
    if (b.kind === 'fill') { fillDraft(b.text); return; }
    if (b.kind === 'schedule') { setScheduleAsk(b); return; }
    if (b.kind === 'link') { navigate(b.href); return; }
    if (b.kind === 'connect_mail') { setMailCard({ resume: b.resume }); return; }
    try {
      const blob = await api.authedBlob(`/api/anthill/messages/${messageId}/export.xlsx`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `qevo-bot-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { showToast({ kind: 'info', title: 'Не получилось', body: e instanceof ApiError ? e.message : 'Попробуйте ещё раз' }); }
  };
  // #4893, п. 2: вернулись после входа в почту — сразу выполняем исходную просьбу, повторять не нужно
  useEffect(() => {
    if (!/[?&]mail_connected=/.test(window.location.search)) return;
    void import('../mail/MailConnectCard').then(async (m) => {
      const r = m.readMailReturn();
      m.clearMailReturn();
      if (!r) return;
      if (!r.connected) { setMailCard({ resume: r.resume ?? undefined }); setErr(r.error || 'Почту подключить не удалось'); return; }
      setMailCard(null);
      const first = await m.waitFirstSummary().catch(() => null);
      if (first?.text) showToast({ kind: 'saved', title: 'Почта подключена', body: first.text });
      if (r.resume) void sendRef.current(r.resume);
    });
  }, []);
  // #4620: вопрос из подсказки обучения или Qevo-бота первого запуска (lib/bot-ask) — сразу в работу
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const w = window as { qevoAsk?: string };
    const take = () => { const q = w.qevoAsk; w.qevoAsk = ''; if (q) void sendRef.current(q); };
    take();
    window.addEventListener('qevo:bot-ask', take);
    return () => window.removeEventListener('qevo:bot-ask', take);
  }, []);

  /*
    #5005: микрофон как в Telegram. Удерживать — говорить, отпустить — сразу отправка;
    смахнуть вверх — отмена. Короткое нажатие — запись до второго нажатия, и тоже сразу
    отправка: раньше после «стоп» текст ложился в поле и нужно было жать «Отправить».
  */
  const voiceSend = useRef(false);
  const voiceCancel = useRef(false);
  const voice = useVoiceInput((text) => {
    if (voiceCancel.current) { voiceCancel.current = false; return; }
    if (voiceSend.current) {
      voiceSend.current = false;
      const d = draft.trim();
      void sendRef.current(d ? `${d} ${text}` : text);
      return;
    }
    setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
    inputRef.current?.focus();
  });
  // #5030: общий для всех мест сценарий микрофона (удержать — говорить, отпустить — отправить, вверх — отмена)
  const hold = useHoldToTalk({
    start: () => { voiceCancel.current = false; voiceSend.current = true; return voice.start(); },
    stop: voice.stop, cancel: voice.cancel, recording: voice.recording, disabled: busy,
  });
  const holding = hold.holding;
  const holdCancel = hold.cancelling;

  /*
    #5008: у карточки «создать задачу / событие / отправить сообщение / стикер» — сразу выбор,
    чем это сделать. Выбрали другое — карточку отменяем и делаем выбранное из той же фразы.
  */
  const switchKind = async (m: AnthillMessage, kind: IntentKind) => {
    const i = messages.findIndex((x) => x.id === m.id);
    const said = [...messages.slice(0, i)].reverse().find((x) => x.role === 'user')?.content?.trim() ?? '';
    if (!said || !m.action) return;
    await act(m.id, m.action.id, 'reject');
    if (kind !== 'sticker') { void send(askFor(kind, said)); return; }
    try {
      const st = await stickersApi.create({ text: said.replace(/^(напомни(те)?(\s+мне)?|не\s+забыть|стикер)\s*[:,—-]?\s*/i, '') || said, source: 'voice', fallback: 'today' });
      stickersChanged();
      setMessages((prev) => [...prev, {
        id: `st-${Date.now()}`, role: 'assistant', content: `📌 Стикер сохранён${st.date ? ` на ${st.date.split('-').reverse().slice(0, 2).join('.')}` : ''}${st.time ? `, ${st.time}` : ''}: «${st.text}»`,
        citations: [], createdAt: new Date().toISOString(), action: null,
      }]);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось сохранить стикер'); }
  };

  const act = async (messageId: string, actionId: string, what: 'confirm' | 'reject' | 'undo') => {
    setErr('');
    const patch = (status: string) => setMessages((prev) => prev.map(
      (m) => (m.id === messageId && m.action ? { ...m, action: { ...m.action, status } } : m),
    ));
    try {
      if (what === 'reject') { await api.anthillReject(actionId); patch('rejected'); return; }
      const r = what === 'confirm' ? await api.anthillConfirm(actionId) : await api.anthillUndo(actionId);
      if (what === 'confirm') feedback('action.confirmed');
      patch(r.status);
      if (r.text) {
        setMessages((prev) => [...prev, {
          id: `act-${Date.now()}`, role: 'assistant', content: r.text, citations: [],
          createdAt: new Date().toISOString(), action: null,
        }]);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось выполнить действие');
    }
  };

  /** «Выполнить все шаги»: оставшиеся карточки прогона разом, итог — одним сообщением. */
  const actRun = async (runId: string, what: 'confirm' | 'reject') => {
    setErr('');
    try {
      if (what === 'reject') {
        await api.anthillRejectRun(runId);
        setMessages((prev) => prev.map((m) => (m.action?.runId === runId && m.action.status === 'pending'
          ? { ...m, action: { ...m.action, status: 'rejected' } } : m)));
        return;
      }
      const r = await api.anthillConfirmRun(runId);
      feedback('action.confirmed');
      const byId = new Map(r.results.map((x) => [x.id, x.status]));
      setMessages((prev) => [
        ...prev.map((m) => (m.action && byId.has(m.action.id)
          ? { ...m, action: { ...m.action, status: byId.get(m.action.id)!, fields: [] } } : m)),
        { id: `act-${Date.now()}`, role: 'assistant' as const, content: r.text, citations: [], createdAt: new Date().toISOString(), action: null },
      ]);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось выполнить шаги');
    }
  };

  /** Сколько шагов прогона ещё ждут — кнопка «Выполнить все» стоит под последним из них. */
  const runPending = (runId: string) => messages.filter((m) => m.action?.runId === runId && m.action.status === 'pending');

  const saveEdit = async (messageId: string, actionId: string, patch: Record<string, string>) => {
    const r = await api.anthillEdit(actionId, patch);
    setMessages((prev) => prev.map((m) => (m.id === messageId && m.action
      ? { ...m, content: r.preview, action: { ...m.action, values: r.values } }
      : m)));
  };

  const vote = (messageId: string, v: 1 | -1, reason?: string) => {
    setVotes((prev) => ({ ...prev, [messageId]: v }));
    api.anthillFeedback(messageId, v, reason).catch(() => undefined);
  };

  /** Ссылка из ответа ведёт к первоисточнику: без перехода проверить ответ нельзя. */
  const openSource = (s: AnthillSource) => {
    // Страница из интернета — в новую вкладку: наш роутер её открыть не может,
    // а увести человека из разговора на чужой сайт тем более нельзя.
    if (s.kind === 'web') { window.open(s.url, '_blank', 'noopener,noreferrer'); return; }
    const url = s.url.replace(/^https?:\/\/[^/]+/, '');
    const task = /\/projects\/([^/]+)\/task\/([^/#?]+)/.exec(url);
    if (task) { navigate({ section: 'projects', projectId: task[1], taskId: task[2] }); return; }
    if (s.kind === 'project') { navigate({ section: 'projects', projectId: String(s.id) }); return; }
    if (s.kind === 'client') { navigate({ section: 'clients', clientId: String(s.id) }); return; }
    if (s.kind === 'meeting') {
      navigate({ section: 'chat', view: 'meetings', meetingId: String(s.id) });
      return;
    }
    const msg = /\/chat\/([^/#?]+)#m([^/#?]+)/.exec(url);
    if (msg) {
      navigate({ section: 'chat', chatId: msg[1] });
      window.setTimeout(() => window.dispatchEvent(
        new CustomEvent('teamcrm:chat-jump', { detail: { chatId: msg[1], messageId: msg[2] } }),
      ), 300);
      return;
    }
    navigate({ section: 'chat', chatId: String(s.id) });
  };

  const ctxLine = context
    ? `${CONTEXT_LABEL[context.type]}${ctxName ? ` «${ctxName}»` : ` #${context.id}`}`
    : '';
  const back = onBack ?? onClose;
  const newChat = () => {
    // #5035, п. 3: «+» — стартовый экран; разговор появится в истории с первым сообщением
    setTab('chat'); setAsk(null); setErr(''); setHistoryOpen(false);
    if (messages.length === 0 && !live) { inputRef.current?.focus(); return; }
    setSessionId(null); setMessages([]);
    try { localStorage.removeItem(LAST_SESSION_KEY); } catch { /* ок */ }
  };
  const histFound = sessions.filter((s) => s.messages > 0 && (!histQ.trim() || s.title.toLowerCase().includes(histQ.trim().toLowerCase())));

  if (screen === 'settings') {
    return (
      <section className={`anthill anthill-v2 anthill-v3${fullscreen ? ' anthill-full' : ''}`} aria-label="Настройки QEVO-бота">
        <Suspense fallback={<div className="anthill-pane dim">Загружаю…</div>}>
          <BotSettings canManage={canManage} onBack={() => setScreen('main')} onRunSkill={(x) => { setSkill(x); setScreen('main'); setTab('chat'); inputRef.current?.focus(); }} />
        </Suspense>
      </section>
    );
  }

  return (
    <section className={`anthill anthill-v2 anthill-v3${fullscreen ? ' anthill-full' : ''}`} aria-label="QEVO-бот">
      {/* #5035, п. 1: в шапке 3 кнопки — «←», «+» и «⋯» */}
      <div className="chat-head anthill-head bv-head">
        {back && (
          <button type="button" className="bv-icon-btn" onClick={back} title={onBack ? 'К списку чатов' : 'Закрыть (Esc)'} aria-label={onBack ? 'К списку чатов' : 'Закрыть'}>
            <Icon name="arrow-left" size={18} />
          </button>
        )}
        <span className="anthill-title">
          <QevoBotMark size={32} />
          <span className="anthill-title-text">
            <b>QEVO-бот</b>
            <span className="dim">AI-помощник<span className="bv-head-eng"> · инженер ответит за 30 сек</span></span>
          </span>
        </span>
        <span className="bv-sp" />
        <button type="button" className="bv-icon-btn" onClick={newChat} title="Новый разговор" aria-label="Новый разговор">
          <Icon name="plus" size={18} />
        </button>
        <DropdownMenu trigger={<button type="button" className="bv-icon-btn" title="Ещё" aria-label="Меню бота"><Icon name="more" size={18} /></button>}>
          <MenuItem onSelect={() => { setTab('chat'); setHistoryOpen(true); loadSessions(); }} icon={<Icon name="clock" size={15} />}>История разговоров</MenuItem>
          <MenuItem onSelect={() => openSupport()} icon={<Icon name="support" size={15} />}>Позвать инженера · 30 сек</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => setScreen('settings')} icon={<Icon name="settings" size={15} />}>
            <span className="bv-menu-two"><span>Настройки бота</span><span className="dim">навыки, память, быстрые ответы, права</span></span>
          </MenuItem>
          {onFullscreen && !fullscreen && <MenuItem onSelect={onFullscreen} icon={<Icon name="maximize" size={15} />}>Открыть на весь экран</MenuItem>}
        </DropdownMenu>
      </div>

      {/* п. 2: вкладки — Чат · Что умеет бот · Автопилоты */}
      <div className="bv-tabs" role="tablist" aria-label="Разделы QEVO-бота">
        {([['chat', 'Чат'], ['services', compact ? 'Что умеет' : 'Что умеет бот'], ['pilots', 'Автопилоты']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => { setTab(k); setHistoryOpen(false); }}>{label}</button>
        ))}
      </div>

      {tab === 'services' && (
        <Suspense fallback={<div className="anthill-pane dim">Загружаю…</div>}>
          <BotServices conn={conn} onConnectMail={() => { setTab('chat'); setMailCard({}); }}
            onPick={(s) => { setTab('chat'); setAsk(s); requestAnimationFrame(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }); }} />
        </Suspense>
      )}
      {tab === 'pilots' && (
        <Suspense fallback={<div className="anthill-pane dim">Загружаю…</div>}>
          <BotPilots onExample={(t) => { setTab('chat'); void send(t); }} onOpenSession={(id) => { setTab('chat'); void openSession(id); }} />
        </Suspense>
      )}

      {tab === 'chat' && historyOpen && (
        <div className="anthill-history bv-history">
          <div className="bv-history-head">
            <b>История разговоров</b>
            <span className="bv-sp" />
            <button type="button" className="msg-icon" onClick={() => setHistoryOpen(false)} aria-label="Закрыть историю"><Icon name="close" size={14} /></button>
          </div>
          <input className="input" value={histQ} onChange={(e) => setHistQ(e.target.value)} placeholder="Поиск по названию" aria-label="Поиск по истории" autoFocus />
          {histFound.length === 0 && <div className="dim anthill-history-empty">{sessions.length ? 'Ничего не нашлось.' : 'Разговоров пока нет — они появятся с первым сообщением.'}</div>}
          {histFound.map((s) => (
            <div key={s.id} className={`anthill-session${String(s.id) === sessionId ? ' active' : ''}`}>
              <button className="anthill-session-open" onClick={() => { void openSession(String(s.id)); }}>
                <span className="anthill-session-title">{s.title}</span>
                <span className="dim">{stampLabel(s.updatedAt)} · {s.messages}</span>
              </button>
              <button
                className="msg-icon"
                onClick={async () => {
                  if (!(await confirmAction({ title: `Удалить разговор «${s.title}»?`, description: 'Переписка с QEVO-ботом пропадёт из истории.', danger: true }))) return;
                  api.anthillDelete(String(s.id))
                    .then(() => { if (String(s.id) === sessionId) { setSessionId(null); setMessages([]); } loadSessions(); })
                    .catch(() => undefined);
                }}
                title="Удалить разговор"
                aria-label="Удалить разговор"
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'chat' && (
      <div className="chat-feed anthill-feed" ref={feedRef}>
        {booting && messages.length === 0 && (
          <div className="bv-boot" role="status"><span className="ui-spinner" /> Загружаю…</div>
        )}
        {!booting && messages.length === 0 && !live && !ask && (
          <div className="anthill-empty">
            <Suspense fallback={<div className="bv-boot" role="status"><span className="ui-spinner" /></div>}>
              <BotStart
                name={user?.fullName ?? null}
                compact={compact}
                onAllServices={() => setTab('services')}
                onPrompt={(t) => { void send(t); }}
                onFill={fillDraft}
                onVoice={() => { if (!voice.recording) voice.toggle(); }}
                onConnectMail={(resume) => { setMailCard({ resume }); }}
              />
            </Suspense>
            {context && <div className="dim">Под рукой {ctxLine} — можно спросить «что здесь осталось сделать?»</div>}
          </div>
        )}

        {mailCard && (
          <Suspense fallback={null}>
            <MailConnectCard resume={mailCard.resume} />
          </Suspense>
        )}
        {scheduleAsk && (
          <Suspense fallback={null}>
            <BotSchedule ask={scheduleAsk} onClose={() => setScheduleAsk(null)} onRun={(t) => { setScheduleAsk(null); void send(t); }} />
          </Suspense>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`anthill-msg anthill-${m.role}`}>
            {m.role === 'assistant'
              ? <RichText text={m.content} className="anthill-body" onOpenImage={setPreview} />
              : <div className="anthill-body">{m.content}</div>}

            {m.citations.length > 0 && (
              <div className="anthill-sources">
                {m.citations.map((s, i) => (
                  <button
                    key={`${s.kind}-${s.id}`}
                    className="anthill-source"
                    onClick={() => openSource(s)}
                    title={`Открыть: ${s.title}`}
                  >
                    <span className="anthill-source-n">{i + 1}</span>
                    <Icon name={SOURCE_ICON[s.kind] ?? 'link'} size={12} />
                    <span className="anthill-source-title">{s.title}</span>
                  </button>
                ))}
              </div>
            )}

            {m.role === 'assistant' && !!m.buttons?.length && !m.action && (
              <div className="anthill-next" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {m.buttons.map((b) => (
                  <button key={b.label} type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void onNext(m.id, b)}>
                    {b.kind === 'download' && <Icon name="download" size={13} />}{b.label}
                  </button>
                ))}
              </div>
            )}

            {m.action && (
              <div className="anthill-action">
                {m.action.status === 'pending' && (
                  <>
                    <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { void act(m.id, m.action!.id, 'confirm'); }}>
                      <Icon name="check" size={13} /> {CONFIRM_LABEL[m.action.tool] ?? 'Создать'}
                    </button>
                    {m.action.fields.length > 0 && (
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setEditing((cur) => (cur === m.id ? null : m.id))}>
                        <Icon name="edit" size={13} /> Редактировать
                      </button>
                    )}
                    <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void act(m.id, m.action!.id, 'reject'); }}>Отмена</button>
                    <span className="dim">пока не подтвердите — ничего не создано</span>
                    {KIND_OF_TOOL[m.action.tool] && !m.action.runId && (
                      <div className="anthill-kind" role="group" aria-label="Что сделать" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, flexBasis: '100%', marginTop: 6 }}>
                        <span className="dim">Что сделать:</span>
                        {(['task', 'event', 'sticker', 'message'] as IntentKind[]).map((k) => (
                          <button key={k} type="button" aria-pressed={KIND_OF_TOOL[m.action!.tool] === k}
                            className={`ui-btn ui-btn-sm ${KIND_OF_TOOL[m.action!.tool] === k ? 'ui-btn-primary' : 'ui-btn-outline'}`}
                            disabled={KIND_OF_TOOL[m.action!.tool] === k}
                            onClick={() => { void switchKind(m, k); }}>{INTENT_LABEL[k]}</button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {m.action.status === 'pending' && m.action.runId && (() => {
                  const left = runPending(m.action.runId);
                  if (left.length < 2 || left[left.length - 1].id !== m.id) return null;
                  const runId = m.action.runId;
                  return (
                    <div className="anthill-form-acts">
                      <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { void actRun(runId, 'confirm'); }}>
                        <Icon name="check" size={13} /> Выполнить все шаги ({left.length})
                      </button>
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void actRun(runId, 'reject'); }}>Отменить все</button>
                    </div>
                  );
                })()}
                {m.action.status === 'done' && (
                  <>
                    <span className="ui-badge ui-badge-ok">{m.action.auto ? 'сделано сразу' : 'сделано'}</span>
                    {m.action.canUndo !== false && (
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void act(m.id, m.action!.id, 'undo'); }}>
                        <Icon name="refresh" size={13} /> Отменить
                      </button>
                    )}
                  </>
                )}
                {m.action.status === 'pending' && editing === m.id && (
                  <ActionForm
                    action={m.action}
                    onCancel={() => setEditing(null)}
                    onSave={async (patch) => {
                      await saveEdit(m.id, m.action!.id, patch);
                      setEditing(null);
                    }}
                  />
                )}
                {m.action.status === 'rejected' && <span className="ui-badge ui-badge-neutral">отклонено</span>}
                {m.action.status === 'undone' && <span className="ui-badge ui-badge-neutral">отменено</span>}
                {m.action.status === 'failed' && <span className="ui-badge ui-badge-warn">не получилось</span>}
              </div>
            )}

            {m.role === 'assistant' && !m.id.startsWith('act-') && !m.id.startsWith('part-') && (
              <Feedback voted={votes[m.id] ?? null} onVote={(v, reason) => vote(m.id, v, reason)} action={!!m.action} />
            )}
          </div>
        ))}

        {ask && (
          <Suspense fallback={null}>
            <ServiceAsk
              service={ask}
              conn={conn}
              onRun={(t) => { setAsk(null); void send(t); }}
              onCancel={() => setAsk(null)}
              onConnectMail={(resume) => { setAsk(null); setMailCard({ resume }); }}
              onMatrix={() => { setAsk(null); setMatrix(true); }}
              onSupport={() => { setAsk(null); openSupport(); }}
            />
          </Suspense>
        )}
        {matrix && (
          <Suspense fallback={null}>
            <BotMatrix onClose={() => setMatrix(false)} onPrompt={(t) => { setMatrix(false); void send(t); }} />
          </Suspense>
        )}

        {live && (
          <div className="anthill-msg anthill-assistant">
            {live.status && (
              <div className="anthill-status">
                <span className="voice-wave" aria-hidden="true"><i /><i /><i /><i /></span>{live.status}
              </div>
            )}
            {live.text && <RichText text={live.text} className="anthill-body" />}
          </div>
        )}

        {err && <div className="tv2-callout tv2-callout-danger anthill-err" role="alert"><Icon name="alert" size={15} /> {err}</div>}
      </div>
      )}

      {tab === 'chat' && (
      <div className="anthill-compose">
        {/* Что открыто на экране — плашкой, снимается крестиком. */}
        {context && useCtx && (
          <div className="anthill-ctx anthill-chip" title="Бот учтёт то, что открыто у вас на экране">
            <Icon name="link" size={12} /> {ctxLine}
            <button className="msg-icon" onClick={() => setUseCtx(false)} title="Спросить без привязки к странице" aria-label="Убрать контекст">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {context && !useCtx && (
          <button className="anthill-ctx-add" onClick={() => setUseCtx(true)} title="Учесть то, что открыто на экране">
            <Icon name="plus" size={12} /> Контекст: {ctxLine}
          </button>
        )}
        {skill && (
          <div className="anthill-ctx anthill-chip anthill-skill-chosen">
            <Icon name="sparkles" size={12} /> Навык: {skill.name}
            <button className="msg-icon" onClick={() => setSkill(null)} title="Пусть бот выберет сам" aria-label="Убрать навык">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {/* п. 8: глубокий анализ — чипом над полем, пока включён */}
        {deep && (
          <div className="anthill-ctx anthill-chip bv-deep-chip" title="Несколько волн поиска и отчёт по разделам: выводы, факты, риски, рекомендации. Дольше обычного ответа.">
            <Icon name="search" size={12} /> Глубокий анализ
            <button className="msg-icon" onClick={() => setDeep(false)} title="Выключить глубокий анализ" aria-label="Выключить глубокий анализ">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <VoiceStatus onDismiss={voice.clearError} recording={voice.recording} transcribing={voice.transcribing} error={voice.error} quiet={voice.quiet} hint={holding ? (holdCancel ? 'отпустите — отменю' : 'отпустите — отправлю · смахните вверх — отмена') : 'нажмите ещё раз — отправлю'} />
        {att.length > 0 && (
          <div className="anthill-att-list">
            {att.map((a) => (
              <span key={a.key} className={`anthill-att${a.error ? ' anthill-att-err' : ''}`} title={a.error ?? a.name}>
                <Icon name={a.data?.kind === 'image' || /\.(png|jpe?g|webp|gif)$/i.test(a.name) ? 'image' : 'paperclip'} size={12} />
                <span className="anthill-att-name">{a.name}</span>
                <span className="anthill-att-state">{a.error ? a.error : a.data ? 'прочитано' : 'читаю…'}</span>
                <button className="msg-icon" onClick={() => setAtt((list) => list.filter((x) => x.key !== a.key))} aria-label={`Убрать ${a.name}`}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input anthill-input">
          <input
            ref={fileRef} type="file" hidden multiple
            accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.xlsx,.txt,.md,.csv,.json"
            onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.currentTarget.value = ''; }}
          />
          {/* п. 8: «+» — Приложить файл · Глубокий анализ */}
          <DropdownMenu align="start" trigger={<button type="button" className="bv-icon-btn bv-plus" disabled={busy} title="Приложить файл или включить глубокий анализ" aria-label="Ещё возможности"><Icon name="plus" size={18} /></button>}>
            <MenuItem onSelect={() => fileRef.current?.click()} disabled={att.length >= 5} icon={<Icon name="paperclip" size={15} />}>Приложить файл</MenuItem>
            <MenuItem onSelect={() => setDeep(!deep)} icon={<Icon name={deep ? 'check' : 'search'} size={15} />}>Глубокий анализ{deep ? ' — включён' : ''}</MenuItem>
          </DropdownMenu>
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
            value={draft}
            placeholder={busy ? 'QEVO-бот отвечает…' : deep ? 'Что разобрать по-крупному?' : compact ? 'Спросите…' : 'Спросите или попросите сделать…'}
            onChange={(e) => setDraft(e.target.value)}
            // скриншот из буфера (Ctrl+V) — сразу вложением
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) { e.preventDefault(); addFiles(files); }
            }}
            onKeyDown={draftEnter.onKeyDown}
            onCompositionEnd={draftEnter.onCompositionEnd}
            disabled={busy}
            aria-label="Вопрос QEVO-боту"
          />
          <button
            className={`${voice.recording ? 'ui-btn ui-btn-primary ui-btn-sm' : 'ui-btn ui-btn-ghost ui-btn-sm'} anthill-mic`}
            {...hold.bind}
            disabled={busy}
            title={voice.recording ? 'Отпустите — отправлю' : 'Удерживайте и говорите — отпустите, отправлю'}
            aria-label={voice.recording ? 'Закончить и отправить' : 'Спросить голосом'}
          >
            <Icon name={voice.recording ? 'stop' : 'mic'} size={16} />
          </button>
          {busy ? (
            <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => stopRef.current?.()} title="Остановить ответ — написанное останется">
              <Icon name="stop" size={14} /> Остановить
            </button>
          ) : (
            <button
              className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { void send(draft); }}
              disabled={reading || (!draft.trim() && !att.some((a) => a.data))}
              title={reading ? 'Дочитываю вложение…' : 'Отправить'} aria-label="Отправить"
            >
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
      )}
      {preview && <Lightbox items={[{ url: preview.url, name: preview.name, mime: preview.mime }]} index={0} onClose={() => setPreview(null)} />}
    </section>
  );
}

/**
 * Правка карточки действия перед созданием.
 *
 * Поля приходят с сервера вместе с действием: панель не знает, из чего состоит
 * задача или напоминание, и не должна знать — завтра инструментов станет больше.
 */
function ActionForm({ action, onSave, onCancel }: {
  action: AnthillAction;
  onSave: (patch: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(action.values);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (key: string, v: string) => setValues((prev) => ({ ...prev, [key]: v }));
  const save = async () => {
    setBusy(true); setErr('');
    try { await onSave(values); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };
  return (
    <div className="anthill-form">
      {action.fields.map((f) => (
        <label key={f.key} className="anthill-form-row">
          <span className="dim">{f.label}</span>
          {f.type === 'multiline' ? (
            <textarea className="input" rows={3} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
          ) : (
            <input
              className="input"
              type={f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text'}
              value={values[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
        </label>
      ))}
      {err && <div className="error-text">{err}</div>}
      <div className="anthill-form-acts">
        <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { void save(); }} disabled={busy}>Сохранить</button>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onCancel} disabled={busy}>Не менять</button>
      </div>
    </div>
  );
}

/**
 * Оценка ответа. Палец вниз спрашивает «что не так»: без причины мера бесполезна —
 * по ней потом правят подсказки модели и инструменты (ТЗ-6, «обучение»).
 */
function Feedback({ voted, onVote, action = false }: { voted: 1 | -1 | null; onVote: (v: 1 | -1, reason?: string) => void; action?: boolean }) {
  const [asking, setAsking] = useState(false);
  /*
    Нажатая кнопка видна сразу (заказчик: «на эти кнопки реакции никакой»): оценка
    уходила на сервер, но стиль «нажато» был только у чата задачи. Стиль — строкой:
    app.css первого экрана у потолка.
  */
  const on = { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent)' };
  return (
    <div className="anthill-feedback">
      <button
        className={`msg-icon${voted === 1 ? ' active' : ''}`}
        onClick={() => { setAsking(false); onVote(1); }}
        title="Полезный ответ" aria-label="Полезный ответ" aria-pressed={voted === 1}
        style={voted === 1 ? on : undefined}
      >
        <Icon name="check-circle" size={13} />
      </button>
      <button
        className={`msg-icon${voted === -1 ? ' active' : ''}`}
        onClick={() => setAsking((v) => !v)}
        title="Ответ не подошёл" aria-label="Ответ не подошёл" aria-expanded={asking} aria-pressed={voted === -1}
        style={voted === -1 || asking ? on : undefined}
      >
        <Icon name="alert" size={13} />
      </button>
      {!asking && voted !== null && (
        <span className="dim" role="status" style={{ fontSize: 12 }}>{voted === 1 ? 'Спасибо, учту' : 'Спасибо, разберёмся'}</span>
      )}
      {asking && <span className="dim" style={{ fontSize: 12 }}>Что не так?</span>}
      {asking && (
        <span className="anthill-reasons">
          {(action ? ACTION_REASONS : REASONS).map((r) => (
            <button key={r.key} className="anthill-reason" onClick={() => { setAsking(false); onVote(-1, r.key); }}>{r.label}</button>
          ))}
        </span>
      )}
    </div>
  );
}
