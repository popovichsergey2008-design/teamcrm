import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { RichText } from '../RichText';
import { VoiceStatus } from '../VoiceStatus';
import { api, ApiError } from '../../lib/api';
import type { AnthillAction, AnthillContext, AnthillMessage, AnthillSession, AnthillSkill, AnthillSource } from '../../lib/api';
import { navigate } from '../../lib/router';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { stampLabel } from '../../lib/chat-text';

/*
  Вкладки кроме «Разговора» открывают редко — их код грузится по первому щелчку,
  а не вместе с приложением: так первый экран не платит за настройки бота.
*/
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
const HINTS = [
  'Что мне сегодня нужно сделать?',
  'Какие задачи просрочены?',
  'Что я пропустил за вчера?',
  'Что решили на последнем мите?',
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
export function AnthillPanel({ context, onClose, fullscreen, onFullscreen }: {
  /** Что открыто у человека под окном — уходит ответом на «о чём речь». */
  context?: AnthillContext | null;
  onClose?: () => void;
  fullscreen?: boolean;
  onFullscreen?: () => void;
}) {
  const [sessions, setSessions] = useState<AnthillSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AnthillMessage[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [draft, setDraft] = useState('');
  const [useCtx, setUseCtx] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const stopRef = useRef<(() => void) | null>(null);
  const busy = live !== null;
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    try { setMessages(await api.anthillMessages(id)); } catch { setMessages([]); }
  };

  const fresh = useCallback(async () => {
    const s = await api.anthillStart(ctxArg);
    setSessionId(String(s.id)); setMessages([]); setHistoryOpen(false); setErr('');
    loadSessions();
    return String(s.id);
  }, [ctxArg, loadSessions]);

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
  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages, live]);

  // Enter — отправить, Shift/Ctrl+Enter — новая строка, после диктовки тоже (useEnterSend)
  const draftEnter = useEnterSend(() => { void send(draft); });
  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setErr('');
    let id: string;
    try { id = sessionId ?? await fresh(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось начать разговор'); return; }
    setDraft('');
    setMessages((prev) => [...prev, {
      id: `me-${Date.now()}`, role: 'user', content: question, citations: [],
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
      onDone: (d) => land(String(d.messageId)),
      onError: (m) => setErr(m || 'Не удалось получить ответ. Попробуйте снова.'),
    });
    stopRef.current = run.stop;
    await run.finished;
    stopRef.current = null;
    // Остановили на середине — набранное остаётся на экране: оно уже сохранено на сервере.
    if (acc.text || pending) land(`part-${Date.now()}`);
    setLive(null);
    loadSessions();
  };

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
      navigate({ section: 'chat', view: 'meetings' });
      window.setTimeout(() => window.dispatchEvent(
        new CustomEvent('teamcrm:meeting-open', { detail: { id: String(s.id) } }),
      ), 300);
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
        <span className="anthill-title">
          <span className="anthill-mark" aria-hidden="true"><Icon name="robot" size={16} /></span>
          <span className="anthill-title-text">
            <b>QEVO Bot</b>
            <span className="dim">AI-помощник</span>
          </span>
        </span>
        <span className="anthill-head-acts">
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { void fresh(); }} title="Новый разговор — с чистого листа">
            <Icon name="plus" size={14} /> Новый
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
        {messages.length === 0 && !live && (
          <div className="anthill-empty">
            <div className="anthill-empty-title">Спросите о задачах, чатах и митах — или попросите сделать</div>
            <div className="anthill-hints">
              {HINTS.map((h) => (
                <button key={h} className="anthill-hint" onClick={() => { setDraft(h); inputRef.current?.focus(); }}>{h}</button>
              ))}
            </div>
            {context && <div className="dim">Под рукой {ctxLine} — можно спросить «что здесь осталось сделать?»</div>}
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`anthill-msg anthill-${m.role}`}>
            {m.role === 'assistant'
              ? <RichText text={m.content} className="anthill-body" />
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
              <Feedback voted={votes[m.id] ?? null} onVote={(v, reason) => vote(m.id, v, reason)} />
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
        <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} hint="нажмите «стоп», когда закончите" />
        <div className="chat-input anthill-input">
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
            value={draft}
            placeholder={busy ? 'QEVO Bot отвечает…' : deep ? 'Что разобрать по-крупному?' : 'Спросите или попросите сделать…'}
            onChange={(e) => setDraft(e.target.value)}
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
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { void send(draft); }} disabled={!draft.trim()} title="Отправить" aria-label="Отправить">
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
      )}
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
function Feedback({ voted, onVote }: { voted: 1 | -1 | null; onVote: (v: 1 | -1, reason?: string) => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="anthill-feedback">
      <button
        className={`msg-icon${voted === 1 ? ' active' : ''}`}
        onClick={() => { setAsking(false); onVote(1); }}
        title="Полезный ответ" aria-label="Полезный ответ"
      >
        <Icon name="check-circle" size={13} />
      </button>
      <button
        className={`msg-icon${voted === -1 ? ' active' : ''}`}
        onClick={() => setAsking((v) => !v)}
        title="Ответ не подошёл" aria-label="Ответ не подошёл" aria-expanded={asking}
      >
        <Icon name="alert" size={13} />
      </button>
      {asking && (
        <span className="anthill-reasons">
          {REASONS.map((r) => (
            <button key={r.key} className="anthill-reason" onClick={() => { setAsking(false); onVote(-1, r.key); }}>{r.label}</button>
          ))}
        </span>
      )}
    </div>
  );
}
