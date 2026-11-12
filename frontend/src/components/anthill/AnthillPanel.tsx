import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QevoBotMark } from '../QevoBotMark';
import { Icon } from '../Icon';
import { RichText } from '../RichText';
import { VoiceStatus } from '../VoiceStatus';
import { api, ApiError } from '../../lib/api';
import type { AnthillAction, AnthillAttachment, AnthillContext, AnthillMessage, AnthillSession, AnthillSkill, AnthillSource } from '../../lib/api';
import { shrinkImage } from '../../lib/image-shrink';
import './anthill-attach.css';
import { Lightbox } from '../LightboxLazy';
import { QuickStart } from './QuickStart';
import { navigate } from '../../lib/router';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { stampLabel } from '../../lib/chat-text';

/*
  Вкладки кроме «Разговора» открывают редко — их код грузится по первому щелчку,
  а не вместе с приложением: так первый экран не платит за настройки бота.
*/
/** Черновик вопроса боту — в общем хранилище черновиков переписки, как у чата `anthill`. */
const BOT_DRAFT_KEY = 'chat:anthill';

const AnthillTasks = lazy(() => import('./AnthillTasks').then((m) => ({ default: m.AnthillTasks })));
const AnthillMemory = lazy(() => import('./AnthillMemory').then((m) => ({ default: m.AnthillMemory })));
const AnthillSkills = lazy(() => import('./AnthillSkills').then((m) => ({ default: m.AnthillSkills })));
const AnthillResponses = lazy(() => import('./AnthillResponses').then((m) => ({ default: m.AnthillResponses })));
const AnthillAdmin = lazy(() => import('./AnthillAdmin').then((m) => ({ default: m.AnthillAdmin })));
import { useAuth } from '../../state/auth';
import { getSocket } from '../../lib/socket';
import { showNotification, showToast } from '../../lib/notifications';
import { useStickyCheck } from '../../lib/sticky-checks';
import { confirmAction } from '../ui/dialog';
import { Tabs } from '../ui/tabs';
import { Toggle } from '../ui/toggle';
import { useEnterSend } from '../../hooks/useEnterSend';
import { feedback } from '../../lib/feedback';
import { readDraft, writeDraft } from '../../lib/chat-drafts';
import { openSupport } from '../support/SupportDock';

const CONTEXT_LABEL: Record<AnthillContext['type'], string> = {
  task: 'задача', project: 'проект', chat: 'чат', meeting: 'мит',
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
/**
 * #4873: открытые вкладки разговоров — как в ChatGPT. Новый разговор — новая вкладка;
 * закрыть вкладку не значит удалить: разговор остаётся в «Истории», его можно открыть снова.
 */
const TABS_KEY = 'qevo.bot.tabs';
const MAX_TABS = 8;
function readTabs(): string[] { try { const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
function writeTabs(ids: string[]) { try { localStorage.setItem(TABS_KEY, JSON.stringify(ids)); } catch { /* вкладки — удобство этого устройства */ } }

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
  const [tabs, setTabsState] = useState<string[]>(readTabs);
  const setTabs = (fn: (ids: string[]) => string[]) => setTabsState((ids) => { const next = fn(ids); writeTabs(next); return next; });
  // новая вкладка — справа; вкладок больше MAX_TABS — уходит самая старая (разговор цел, он в «Истории»)
  const addTab = (id: string) => setTabs((ids) => (ids.includes(id) ? ids : [...ids, id].slice(-MAX_TABS)));
  const [votes, setVotes] = useState<Record<string, 1 | -1>>({});
  /** Карточка, открытая на правку: одна за раз — их и бывает одна. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Разговор · Задачи · Навыки · Память (ТЗ-6, MVP 2): вкладки одного помощника. */
  const [tab, setTab] = useState<'chat' | 'tasks' | 'skills' | 'memory' | 'responses' | 'admin'>('chat');
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
  /** #1326: быстрый старт поверх идущего разговора — по кнопке в шапке. */
  const [quickShown, setQuickShown] = useState(false);
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
    setSessionId(id); setHistoryOpen(false); setErr('');
    rememberSession(id); addTab(id);
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
      if (!alive || !list.length) return;
      const last = lastSession();
      const pick = list.find((x) => String(x.id) === last) ?? list[0];
      // первый раз — три последних разговора вкладками; дальше — что человек сам держит открытым,
      // без вкладок удалённых разговоров
      const known = new Set(list.map((x) => String(x.id)));
      setTabs((ids) => (ids.length ? ids.filter((x) => known.has(x)) : list.slice(0, 3).map((x) => String(x.id)).reverse()));
      void openSession(String(pick.id));
    }).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // активная вкладка — в поле зрения: на телефоне полоса вкладок шире экрана
  useEffect(() => {
    document.querySelector('.anthill-convtab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [sessionId, tabs.length]);

  const fresh = useCallback(async () => {
    // открытый разговор ещё пуст — он и есть «новый»: не плодим пустые вкладки
    if (sessionId && messages.length === 0 && !live) { setQuickShown(false); inputRef.current?.focus(); return sessionId; }
    const s = await api.anthillStart(ctxArg);
    setSessionId(String(s.id)); setMessages([]); setHistoryOpen(false); setErr(''); setQuickShown(false);
    rememberSession(String(s.id)); addTab(String(s.id));
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
      showToast({ kind: 'saved', title: 'QEVO Bot: задача выполнена', body: p?.title ?? 'Отчёт готов и ждёт в «Заметках»' });
      showNotification('QEVO Bot', `${p?.title ?? 'Регулярная задача'} — отчёт готов`);
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
      }, ...steps]);
    };

    const run = api.anthillAsk(id, question, ctxArg, skill ? skill.id : null, deep, {
      onStatus: (t) => { acc.status = t; show(); },
      onDelta: (t) => { acc.text += t; acc.status = ''; show(); },
      onSources: (s) => { acc.sources = s; show(); },
      onAction: (a) => { pending = a; },
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

  const voice = useVoiceInput((text) => {
    setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
    inputRef.current?.focus();
  });

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

  return (
    <section className={`anthill anthill-v2${fullscreen ? ' anthill-full' : ''}`} aria-label="QEVO Bot">
      <div className="chat-head anthill-head">
        {onBack && (
          <button className="ui-btn ui-btn-ghost ui-btn-sm chat-back" onClick={onBack} title="К списку чатов" aria-label="К списку чатов">
            <Icon name="chevron-left" size={16} />
          </button>
        )}
        <span className="anthill-title">
          <QevoBotMark size={32} />
          <span className="anthill-title-text">
            <b>QEVO Bot</b>
            <span className="dim">AI-помощник</span>
          </span>
        </span>
        <span className="anthill-head-acts">
          {/* #1326: новый разговор — заметной кнопкой; прежние остаются в «Истории» */}
          <button
            className="ui-btn ui-btn-primary ui-btn-sm anthill-new"
            onClick={() => {
              setTab('chat'); setQuickShown(false);
              fresh().catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось начать новый разговор'));
            }}
            title="Начать новый разговор с чистого листа. Прежние разговоры — в «Истории»"
          >
            <Icon name="plus" size={14} /> Новый разговор
          </button>
          <button
            className={`ui-btn ui-btn-ghost ui-btn-sm${quickShown ? ' active' : ''}`}
            onClick={() => {
              setTab('chat');
              // #4876: подсказки встают в начало ленты, а лента стоит внизу — без прокрутки
              // казалось, что кнопка ничего не делает
              setQuickShown((v) => { if (!v) requestAnimationFrame(() => feedRef.current?.scrollTo({ top: 0, behavior: 'smooth' })); return !v; });
            }}
            aria-expanded={quickShown}
            title="Быстрый старт: что бот умеет взять на себя"
          >
            <QevoBotMark size={18} /> Что умею
          </button>
          {/* #4807 §5, п. 14: «Помощь и бот» — одна точка помощи: живой инженер отсюда же */}
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => openSupport()} title="Позвать живого инженера службы заботы — ответит за 30 секунд">
            <Icon name="support" size={14} /> Позвать инженера
          </button>
          <button
            className={`ui-btn ui-btn-ghost ui-btn-sm${historyOpen ? ' active' : ''}`}
            onClick={() => { setHistoryOpen((v) => !v); loadSessions(); }}
            title="История разговоров"
            aria-label="История разговоров"
            aria-expanded={historyOpen}
          >
            <Icon name="clock" size={14} />
          </button>
          {onFullscreen && !fullscreen && (
            <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onFullscreen} title="Открыть на весь экран" aria-label="Открыть на весь экран">
              <Icon name="maximize" size={14} />
            </button>
          )}
          {onClose && (
            <button className="ui-btn ui-btn-ghost ui-btn-sm chat-overlay-close" onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть">
              <Icon name="close" size={16} />
            </button>
          )}
        </span>
      </div>

      <Tabs
        className="anthill-tabs-v2"
        ariaLabel="Разделы QEVO Bot"
        value={tab}
        onValueChange={setTab}
        items={([
          { key: 'chat', label: 'Разговор', icon: 'chat' },
          { key: 'tasks', label: 'Задачи', icon: 'clock' },
          { key: 'skills', label: 'Навыки', icon: 'sparkles' },
          { key: 'memory', label: 'Память', icon: 'book' },
          ...(canManage ? [{ key: 'responses', label: 'Ответы', icon: 'reply' }, { key: 'admin', label: 'Настройки', icon: 'settings' }] as const : []),
        ] as const).map((t) => ({ value: t.key, label: <><Icon name={t.icon} size={14} /> {t.label}</> }))}
      />

      <Suspense fallback={tab !== 'chat' ? <div className="anthill-pane dim">Загружаю…</div> : null}>
        {tab === 'tasks' && <AnthillTasks onOpenSession={(id) => { setTab('chat'); void openSession(id); }} />}
        {tab === 'skills' && (
          <AnthillSkills onRun={(x) => { setSkill(x); setTab('chat'); inputRef.current?.focus(); }} />
        )}
        {tab === 'memory' && <AnthillMemory />}
        {tab === 'responses' && canManage && <AnthillResponses />}
        {tab === 'admin' && canManage && <AnthillAdmin />}
      </Suspense>

      {tab === 'chat' && (
        <div className="anthill-convtabs" role="tablist" aria-label="Разговоры с QEVO Bot">
          {tabs.map((id) => {
            const s = sessions.find((x) => String(x.id) === id);
            const title = s && s.messages > 0 ? s.title : 'Новый разговор';
            const on = id === sessionId;
            return (
              <div key={id} className={`anthill-convtab${on ? ' on' : ''}`} role="presentation">
                <button role="tab" aria-selected={on} className="anthill-convtab-open" onClick={() => { if (!on) void openSession(id); }} title={title}>
                  <Icon name="chat" size={13} /> <span>{title}</span>
                </button>
                <button
                  className="anthill-convtab-x"
                  aria-label={`Закрыть вкладку «${title}»`}
                  title="Закрыть вкладку — разговор останется в «Истории»"
                  onClick={() => {
                    const rest = tabs.filter((x) => x !== id);
                    setTabs(() => rest);
                    if (on) {
                      const next = rest[Math.min(tabs.indexOf(id), rest.length - 1)];
                      if (next) void openSession(next); else { setSessionId(null); setMessages([]); }
                    }
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
          <button
            className="anthill-convtab-new"
            onClick={() => { setTab('chat'); fresh().catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось начать новый разговор')); }}
            title="Новый разговор — в новой вкладке"
            aria-label="Новый разговор"
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
      )}

      {tab === 'chat' && historyOpen && (
        <div className="anthill-history">
          {sessions.length === 0 && <div className="dim anthill-history-empty">Разговоров пока нет.</div>}
          {sessions.map((s) => (
            <div key={s.id} className={`anthill-session${String(s.id) === sessionId ? ' active' : ''}`}>
              <button className="anthill-session-open" onClick={() => { void openSession(String(s.id)); }}>
                <span className="anthill-session-title">{s.title}</span>
                <span className="dim">{stampLabel(s.updatedAt)} · {s.messages}</span>
              </button>
              <button
                className="msg-icon"
                onClick={async () => {
                  if (!(await confirmAction({ title: `Удалить разговор «${s.title}»?`, description: 'Переписка с QEVO Bot пропадёт из истории.', danger: true }))) return;
                  api.anthillDelete(String(s.id))
                    .then(() => {
                      if (String(s.id) === sessionId) { setSessionId(null); setMessages([]); }
                      setTabs((ids) => ids.filter((x) => x !== String(s.id)));
                      loadSessions();
                    })
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
        {quickShown && messages.length > 0 && (
          <div className="anthill-empty">
            <QuickStart onPick={(p) => { setQuickShown(false); void send(p); }} />
          </div>
        )}
        {messages.length === 0 && !live && (
          <div className="anthill-empty">
            <div className="anthill-empty-title">Спросите о задачах, чатах и митах — или попросите сделать</div>
            <QuickStart onPick={(p) => { void send(p); }} />
            {context && <div className="dim">Под рукой {ctxLine} — можно спросить «что здесь осталось сделать?»</div>}
          </div>
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

            {m.action && (
              <div className="anthill-action">
                {m.action.status === 'pending' && (
                  <>
                    <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { void act(m.id, m.action!.id, 'confirm'); }}>
                      <Icon name="check" size={13} /> Создать
                    </button>
                    {m.action.fields.length > 0 && (
                      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setEditing((cur) => (cur === m.id ? null : m.id))}>
                        <Icon name="edit" size={13} /> Редактировать
                      </button>
                    )}
                    <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void act(m.id, m.action!.id, 'reject'); }}>Отмена</button>
                    <span className="dim">пока не подтвердите — ничего не создано</span>
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
        {/*
          Что открыто на экране — плашкой, а не галочкой.

          Агент и так отвечает про то, что перед глазами: галочка требовала решения
          там, где решение уже принято, и висела в композере постоянно. Плашка просто
          сообщает, о чём пойдёт речь, и снимается крестиком, если речь о другом.
        */}
        {context && useCtx && (
          <div className="anthill-ctx anthill-chip" title="Агент учтёт то, что открыто у вас на экране">
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
            <button className="msg-icon" onClick={() => setSkill(null)} title="Пусть агент выберет сам" aria-label="Убрать навык">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <Toggle
          className="anthill-deep-v2"
          pressed={deep}
          onPressedChange={setDeep}
          title="Несколько волн поиска и отчёт по разделам: выводы, факты, риски, рекомендации. Дольше и дороже обычного ответа."
        >
          <Icon name="search" size={13} /> Глубокий анализ
        </Toggle>
        <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} quiet={voice.quiet} hint="нажмите «стоп», когда закончите" />
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
          <button
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => fileRef.current?.click()}
            disabled={busy || att.length >= 5}
            title="Приложить скриншот, фото или документ — бот прочитает и ответит с учётом файла. Скриншот можно вставить Ctrl+V"
            aria-label="Приложить файл"
          >
            <Icon name="paperclip" size={16} />
          </button>
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
            value={draft}
            placeholder={busy ? 'QEVO Bot отвечает…' : deep ? 'Что разобрать по-крупному?' : 'Спросите или попросите сделать…'}
            onChange={(e) => setDraft(e.target.value)}
            // скриншот из буфера (Ctrl+V) — сразу вложением
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) { e.preventDefault(); addFiles(files); }
            }}
            onKeyDown={draftEnter.onKeyDown}
            onCompositionEnd={draftEnter.onCompositionEnd}
            disabled={busy}
            aria-label="Вопрос QEVO Bot"
          />
          <button
            className={voice.recording ? 'ui-btn ui-btn-primary ui-btn-sm' : 'ui-btn ui-btn-ghost ui-btn-sm'}
            onClick={voice.toggle}
            disabled={busy}
            title={voice.recording ? 'Остановить и распознать' : 'Спросить голосом'}
            aria-label="Спросить голосом"
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
