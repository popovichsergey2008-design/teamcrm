import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../Icon';
import { api, ApiError, request } from '../../lib/api';
import { stampLabel } from '../../lib/chat-text';
import { navigate } from '../../lib/router';
import { showToast, toastSaved } from '../../lib/notifications';
import { useAuth } from '../../state/auth';
import { confirmAction, promptText } from '../ui/dialog';
import { Decision, decisionsApi, DECISIONS_CHANGED, DecisionsTab, notifyDecisionsChanged, Question } from './chat-decisions-api';
import './chat-tabs.css';

/**
 * #4902, п. 9: вкладки чата проекта «Чат / Треды / Решения / Задачи / Встречи / Файлы».
 *
 * Вкладки — навигация по уже существующим видам: лента остаётся на месте, а «Треды»,
 * «Решения», «Задачи», «Встречи» открываются в правом слоте (там же, где сведения ⓘ
 * и ветка), «Файлы» — материалы в сведениях чата. Так источник решения открывается
 * в ленте рядом, не теряя вкладку. Всё — ленивым куском: первый экран о нём не знает.
 */

export type ChatTab = 'chat' | 'threads' | 'decisions' | 'tasks' | 'meetings' | 'files';
const TABS: { key: ChatTab; label: string; icon: IconName }[] = [
  { key: 'chat', label: 'Чат', icon: 'chat' },
  { key: 'threads', label: 'Треды', icon: 'reply' },
  { key: 'decisions', label: 'Решения', icon: 'flag' },
  { key: 'tasks', label: 'Задачи', icon: 'check' },
  { key: 'meetings', label: 'Встречи', icon: 'record' },
  { key: 'files', label: 'Файлы', icon: 'file' },
];

const fail = (title: string, e: unknown) => showToast({ title, body: e instanceof ApiError ? e.message : 'Ошибка', section: 'chat' });
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export function ChatTabsBar({ tab, onTab }: { tab: string; onTab: (t: ChatTab) => void }) {
  return (
    <div className="ct-bar" role="tablist" aria-label="Разделы чата">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          className={`ct-tab${tab === t.key ? ' active' : ''}`}
          onClick={() => onTab(t.key)}
        >
          <Icon name={t.icon} size={13} /> {t.label}
        </button>
      ))}
    </div>
  );
}

interface ThreadLike { root_id: string; chat_id: string; root_body: string; root_author: string | null; reply_count: number; last_reply_at: string | null; unread: number }

export function ChatTabPane({ tab, chatId, threads, onClose, onJumpTo, onOpenThread, onCall, canCall }: {
  tab: string; chatId: string; threads: ThreadLike[];
  onClose: () => void;
  onJumpTo: (messageId: string) => void;
  onOpenThread: (rootId: string) => void;
  onCall: (memberIds: string[]) => void;
  canCall: boolean;
}) {
  const title = TABS.find((t) => t.key === tab)?.label ?? '';
  return (
    <aside className="chat-info ct-pane" aria-label={title}>
      <div className="chat-info-head">
        <b><Icon name={TABS.find((t) => t.key === tab)?.icon ?? 'list'} size={15} /> {title}</b>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть" aria-label="Закрыть"><Icon name="close" size={15} /></button>
      </div>
      <div className="chat-info-body ct-body">
        {tab === 'decisions' && <DecisionsPane chatId={chatId} onJumpTo={onJumpTo} onCall={onCall} canCall={canCall} />}
        {tab === 'tasks' && <TasksPane chatId={chatId} />}
        {tab === 'threads' && <ThreadsPane threads={threads.filter((t) => String(t.chat_id) === String(chatId))} onOpen={onOpenThread} />}
        {tab === 'meetings' && <MeetingsPane chatId={chatId} />}
      </div>
    </aside>
  );
}

// ---------- Решения ----------

type Filter = 'all' | 'open' | 'done';

function DecisionsPane({ chatId, onJumpTo, onCall, canCall }: {
  chatId: string; onJumpTo: (id: string) => void; onCall: (memberIds: string[]) => void; canCall: boolean;
}) {
  const { user } = useAuth();
  const [data, setData] = useState<DecisionsTab | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    decisionsApi.tab(chatId).then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить решения'));
  }, [chatId]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => {
    window.addEventListener(DECISIONS_CHANGED, load);
    return () => window.removeEventListener(DECISIONS_CHANGED, load);
  }, [load]);

  /** Действие с кнопки: занято, ошибка — всплывашкой, потом перечитать. */
  const run = async (key: string, fn: () => Promise<unknown>, errTitle: string) => {
    setBusy(key);
    try { await fn(); notifyDecisionsChanged(); } catch (e) { fail(errTitle, e); } finally { setBusy(null); }
  };

  const shown = useMemo(() => (data?.decisions ?? []).filter((d) => filter === 'all' || (filter === 'done' ? d.done : !d.done)), [data, filter]);

  if (err) return <div className="error-text ct-pad">{err}</div>;
  if (!data) return <div className="dim ct-pad">Загружаю…</div>;

  const suggest = async () => {
    setBusy('suggest'); setNote('');
    try { setNote((await decisionsApi.suggest(chatId)).note); load(); } catch (e) { fail('ИИ не ответил', e); } finally { setBusy(null); }
  };

  const solve = async (q: Question, how: 'poll' | 'call' | 'decided' | 'dismissed' | 'reopen') => {
    if (how === 'poll') {
      const raw = await promptText({
        title: 'Опрос участникам чата', description: `«${q.text.slice(0, 160)}» — варианты ответа, каждый с новой строки.`,
        defaultValue: 'Да\nНет', confirmLabel: 'Запустить опрос', minLength: 1,
      });
      if (raw == null) return;
      return run(`q:${q.key}`, () => decisionsApi.resolve(chatId, { key: q.key, how, options: raw.split(/[\n;]+/) }), 'Опрос не запустился');
    }
    if (how === 'call') {
      if (!canCall) { showToast({ title: 'Вы уже в созвоне', body: 'Закончите текущий — и позовите на новый', section: 'chat' }); return; }
      const members = await api.chatMembers(chatId).then((r) => r.members.map((m) => String(m.userId)).filter((id) => id !== String(user?.id ?? ''))).catch(() => [] as string[]);
      onCall(members);
      return run(`q:${q.key}`, () => decisionsApi.resolve(chatId, { key: q.key, how }), 'Не удалось отметить созвон');
    }
    if (how === 'decided') {
      const text = await promptText({ title: 'Что решили?', description: `Вопрос: «${q.text.slice(0, 160)}»`, confirmLabel: 'Записать решение', minLength: 2 });
      if (!text) return;
      return run(`q:${q.key}`, () => decisionsApi.resolve(chatId, { key: q.key, how, text }), 'Решение не записалось');
    }
    return run(`q:${q.key}`, () => decisionsApi.resolve(chatId, { key: q.key, how }), 'Не получилось');
  };

  const openQuestions = data.questions;

  return (
    <div className="ct-dec">
      <div className="ct-dec-top">
        <span className="ct-chips" role="group" aria-label="Фильтр решений">
          {([['all', `Все · ${data.counts.decisions}`], ['open', `Не выполнены · ${data.counts.open}`], ['done', 'Выполнены']] as [Filter, string][]).map(([k, label]) => (
            <button key={k} type="button" className={`ct-chip${filter === k ? ' active' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </span>
        <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy === 'suggest'} onClick={() => void suggest()} title="ИИ прочитает переписку за 30 дней и предложит решения — записываются только после вашего подтверждения">
          <Icon name="sparkles" size={13} /> {busy === 'suggest' ? 'Читаю…' : 'Найти решения'}
        </button>
      </div>
      {note && <div className="dim ct-note">{note}</div>}

      {data.candidates.length > 0 && (
        <section className="ct-block">
          <h4 className="ct-h"><Icon name="sparkles" size={13} /> Похоже на решение — подтвердите <span className="ci-count">{data.candidates.length}</span></h4>
          {data.candidates.map((k) => (
            <div key={k.id} className="ct-card ct-cand">
              <div className="ct-text">{k.text}</div>
              <div className="ct-meta">
                <span>{k.origin === 'ai' ? 'предложил ИИ' : 'по словам «решили / договорились…»'}</span>
                <span>{k.author ?? '—'} · {stampLabel(k.at)}</span>
                <button className="ct-link" onClick={() => onJumpTo(k.messageId)}>сообщение</button>
              </div>
              <div className="ct-actions">
                <button
                  className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy === `k:${k.id}`}
                  onClick={async () => {
                    const text = await promptText({ title: 'Записать решение', description: 'Поправьте формулировку, если нужно.', defaultValue: k.text, confirmLabel: 'Это решение', minLength: 2 });
                    if (text) await run(`k:${k.id}`, () => decisionsApi.candidate(k.id, true, text), 'Решение не записалось');
                  }}
                ><Icon name="check" size={13} /> Это решение</button>
                <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy === `k:${k.id}`} onClick={() => void run(`k:${k.id}`, () => decisionsApi.candidate(k.id, false), 'Не получилось')}>Не решение</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="ct-block">
        <h4 className="ct-h"><Icon name="flag" size={13} /> Журнал решений</h4>
        {!shown.length && (
          <div className="dim">
            {data.decisions.length ? 'Под этот фильтр решений нет.' : 'Решений пока нет. Отметьте сообщение «Отметить как решение» в его меню — или нажмите «Найти решения». Решения со встреч из этого чата приходят сюда сами.'}
          </div>
        )}
        {shown.map((d) => <DecisionRow key={d.id} d={d} busy={busy === `d:${d.id}`} onJumpTo={onJumpTo} run={(fn, t) => run(`d:${d.id}`, fn, t)} />)}
      </section>

      <section className="ct-block">
        <h4 className="ct-h"><Icon name="help" size={13} /> Вопросы без ответа {openQuestions.length > 0 && <span className="ci-count">{openQuestions.length}</span>}</h4>
        {!openQuestions.length && <div className="dim">Вопросов без ответа нет.</div>}
        {openQuestions.map((q) => (
          <div key={q.key} className="ct-card">
            <div className="ct-text">{q.text}</div>
            <div className="ct-meta">
              {q.source.kind === 'message'
                ? <><span>{q.author ?? '—'} · {stampLabel(q.at)}</span><button className="ct-link" onClick={() => onJumpTo((q.source as { messageId: string }).messageId)}>сообщение</button></>
                : <button className="ct-link" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId: (q.source as { meetingId: string }).meetingId })}>со встречи «{(q.source as { title: string }).title}»</button>}
              {q.state?.state === 'poll' && (
                <button className="ct-chip-ok" onClick={() => navigate(q.state?.pollPostId ? { section: 'news', postId: q.state.pollPostId } : { section: 'news' })}>идёт опрос →</button>
              )}
              {q.state?.state === 'call' && <span className="ct-chip-ok">позвали на созвон{q.state.by ? ` · ${q.state.by}` : ''}</span>}
            </div>
            <QuestionActions q={q} busy={busy === `q:${q.key}`} onSolve={(how) => void solve(q, how)} />
          </div>
        ))}
      </section>
    </div>
  );
}

function DecisionRow({ d, busy, onJumpTo, run }: {
  d: Decision; busy: boolean; onJumpTo: (id: string) => void;
  run: (fn: () => Promise<unknown>, errTitle: string) => Promise<void>;
}) {
  const src = d.source;
  return (
    <div className={`ct-card${d.done ? ' ct-done' : ''}`}>
      <div className="ct-text">{d.text}</div>
      <div className="ct-meta">
        <span>решили {day(d.decidedAt)}{d.who ? ` · ${d.who}` : ''}</span>
        {src.kind === 'message' && src.messageId && <button className="ct-link" onClick={() => onJumpTo(src.messageId!)} title="Показать сообщение в ленте">источник: сообщение</button>}
        {src.kind === 'meeting' && (
          <button className="ct-link" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId: src.meetingId })} title="Открыть встречу">
            источник: встреча «{src.title ?? 'созвон'}»
          </button>
        )}
      </div>
      <div className="ct-meta">
        {d.task
          ? (
            <button className="ct-link" onClick={() => d.task?.projectId && navigate({ section: 'projects', projectId: d.task.projectId, taskId: d.task.id })} title="Открыть задачу">
              задача #{d.task.id}{d.task.status ? ` · ${d.task.closed ? 'закрыта' : d.task.status}` : ''}
            </button>
          )
          : <span>задачи нет</span>}
        <span className={d.done ? 'ct-chip-ok' : 'ct-chip-open'}>
          {d.done ? (d.doneBy === 'task' ? 'выполнено — задача закрыта' : `выполнено${d.doneByName ? ` · отметил(а) ${d.doneByName}` : ''}`) : 'не выполнено'}
        </span>
        {d.supersededBy && <span title={d.supersededBy.text ?? ''}>изменено позже</span>}
      </div>
      <div className="ct-actions">
        {!d.task && (
          <>
            <button
              className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy}
              onClick={async () => {
                const title = await promptText({ title: 'Поставить задачу по решению', description: 'Задача уйдёт в проект чата и будет связана с решением.', defaultValue: d.text, confirmLabel: 'Поставить', minLength: 2, singleLine: true });
                if (title) await run(async () => { const r = await decisionsApi.task(d.id, { title }); toastSaved(`Задача #${r.taskId} поставлена`); }, 'Задача не создалась');
              }}
            ><Icon name="plus" size={13} /> Задача</button>
            <button
              className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy}
              onClick={async () => {
                const n = await promptText({ title: 'Связать с задачей', description: 'Номер существующей задачи, например 1234.', confirmLabel: 'Связать', singleLine: true });
                if (n) await run(() => decisionsApi.task(d.id, { taskId: n.trim() }), 'Не удалось связать');
              }}
            ><Icon name="link" size={13} /> Связать</button>
          </>
        )}
        {d.doneBy !== 'task' && (
          <label className="ct-check">
            <input type="checkbox" checked={d.done} disabled={busy} onChange={(e) => void run(() => decisionsApi.done(d.id, e.target.checked), 'Не получилось')} />
            Выполнено
          </label>
        )}
        <button
          className="ui-btn ui-btn-ghost ui-btn-sm ct-mute" disabled={busy}
          onClick={async () => {
            if (!await confirmAction({ title: 'Снять решение?', description: 'Оно пропадёт из вкладки, но останется в истории журнала.', confirmLabel: 'Снять', danger: true })) return;
            await run(() => decisionsApi.revoke(d.id), 'Не удалось снять');
          }}
        >Снять</button>
      </div>
    </div>
  );
}

function QuestionActions({ q, busy, onSolve }: { q: Question; busy: boolean; onSolve: (how: 'poll' | 'call' | 'decided' | 'dismissed' | 'reopen') => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="ct-actions">
        <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy} onClick={() => setOpen(true)}>Решить</button>
        {q.state && <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => onSolve('reopen')}>Сбросить</button>}
      </div>
    );
  }
  const pick = (how: 'poll' | 'call' | 'decided' | 'dismissed') => { setOpen(false); onSolve(how); };
  return (
    <div className="ct-actions">
      <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => pick('poll')}><Icon name="chart" size={13} /> Опрос</button>
      <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => pick('call')}><Icon name="phone" size={13} /> Созвон</button>
      <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => pick('decided')}><Icon name="flag" size={13} /> Записать решение</button>
      <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => pick('dismissed')}>Не вопрос</button>
      <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setOpen(false)} aria-label="Отмена"><Icon name="close" size={13} /></button>
    </div>
  );
}

// ---------- Задачи по статусам ----------

interface ChatTask { id: string; title: string; status: string; closed: boolean; deadlineAt: string | null; projectId: string; assigneeName: string | null; relation: string }

function TasksPane({ chatId }: { chatId: string }) {
  const [data, setData] = useState<{ total: number; projectId: string | null; items: ChatTask[] } | null>(null);
  useEffect(() => {
    request<{ total: number; projectId: string | null; items: ChatTask[] }>('GET', `/chats/${chatId}/tasks`)
      .then(setData).catch(() => setData({ total: 0, projectId: null, items: [] }));
  }, [chatId]);
  const groups = useMemo(() => {
    const m = new Map<string, ChatTask[]>();
    for (const t of data?.items ?? []) {
      const k = t.closed ? 'Завершены' : (t.status || 'В работе');
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    // открытые статусы — первыми, «Завершены» — в конце
    return [...m.entries()].sort((a, b) => (a[0] === 'Завершены' ? 1 : 0) - (b[0] === 'Завершены' ? 1 : 0));
  }, [data]);
  if (!data) return <div className="dim ct-pad">Загружаю…</div>;
  return (
    <div className="ct-dec">
      {!data.items.length && <div className="dim">Из этого чата задач ещё не ставили — «Создать задачу» есть в меню сообщения.</div>}
      {groups.map(([status, list]) => (
        <section key={status} className="ct-block">
          <h4 className="ct-h">{status} <span className="ci-count">{list.length}</span></h4>
          {list.map((t) => (
            <button key={t.id} className="ci-item" onClick={() => navigate({ section: 'projects', projectId: t.projectId, taskId: t.id })} title="Открыть задачу">
              <Icon name={t.closed ? 'check-circle' : 'check'} size={14} />
              <span className="ci-item-main">
                <span className="ci-item-name">#{t.id} {t.title}</span>
                <span className="dim">
                  {t.assigneeName ?? 'без исполнителя'}
                  {t.deadlineAt ? ` · до ${new Date(t.deadlineAt).toLocaleDateString('ru-RU')}` : ''}
                </span>
              </span>
            </button>
          ))}
        </section>
      ))}
      {data.projectId && <button className="ci-link" onClick={() => navigate({ section: 'projects', projectId: String(data.projectId) })}>Все задачи проекта →</button>}
    </div>
  );
}

// ---------- Треды ----------

function ThreadsPane({ threads, onOpen }: { threads: ThreadLike[]; onOpen: (rootId: string) => void }) {
  if (!threads.length) return <div className="dim ct-pad">Веток в этом чате пока нет — «Ответить в ветке» есть в меню сообщения.</div>;
  return (
    <div className="ct-dec">
      {threads.map((t) => (
        <button key={t.root_id} className="ci-item" onClick={() => onOpen(String(t.root_id))} title="Открыть ветку">
          <Icon name="reply" size={14} />
          <span className="ci-item-main">
            <span className="ci-item-name">{t.root_body || 'вложение'}</span>
            <span className="dim">
              {t.root_author ?? ''} · ответов: {t.reply_count}{t.last_reply_at ? ` · ${stampLabel(t.last_reply_at)}` : ''}
              {t.unread > 0 ? ` · новых: ${t.unread}` : ''}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------- Встречи ----------

const MEETING_STATUS: Record<string, string> = { queued: 'в очереди', transcribing: 'расшифровка', analyzing: 'разбор', done: 'разобрана', error: 'ошибка' };

function MeetingsPane({ chatId }: { chatId: string }) {
  const [items, setItems] = useState<{ id: string; title: string; at: string; status: string; tasksCreated: number; summary: string | null }[] | null>(null);
  useEffect(() => { api.chatMeetings(chatId).then(setItems).catch(() => setItems([])); }, [chatId]);
  if (!items) return <div className="dim ct-pad">Загружаю…</div>;
  return (
    <div className="ct-dec">
      {!items.length && <div className="dim">Созвонов из этого чата ещё не было — кнопка «Созвон» в шапке.</div>}
      {items.map((m) => (
        <button key={m.id} className="ci-item" onClick={() => navigate({ section: 'chat', view: 'meetings', meetingId: m.id })} title="Открыть встречу">
          <Icon name="record" size={14} />
          <span className="ci-item-main">
            <span className="ci-item-name">{m.title}</span>
            <span className="dim">{stampLabel(m.at)} · {MEETING_STATUS[m.status] ?? m.status}{m.tasksCreated ? ` · задач: ${m.tasksCreated}` : ''}</span>
          </span>
        </button>
      ))}
      <button className="ci-link" onClick={() => navigate({ section: 'chat', view: 'meetings' })}>Все встречи →</button>
    </div>
  );
}
