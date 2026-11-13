import { useEffect, useMemo, useState } from 'react';
import { ApiError, request } from '../../lib/api';
import { feedback } from '../../lib/feedback';
import { navigate } from '../../lib/router';
import { Icon } from '../Icon';

/*
  #4902, пп. 7–8 — ленивый кусок под сообщением чата.
  п. 7: все поручения сообщения одной карточкой — кому, что, срок, проект, похожие задачи;
        «Создать N» / «Изменить» / «Не задачи»; недостающее подсвечено и правится прямо здесь.
  п. 8: «Кто за это отвечает?» — ответ из задач, ТЗ и протоколов встреч с источниками; видит
        только спросивший; «Ответить этим в чат», «Напомнить [кому]».
  ИИ предлагает — человек подтверждает: без нажатия ничего не создаётся и в чат не уходит.
*/

interface Similar { id: string; title: string; projectId: string; status: string | null; closed: boolean; score: number }
interface Item {
  key: string; title: string; assigneeId: string | null; assignee: string | null; assigneeHint: string | null;
  deadline: string | null; quote: string; taskId?: string | null; linkTaskId?: string | null; skip?: boolean;
  missing: ('assignee' | 'deadline')[]; similar: Similar[]; suggestLink: string | null;
}
interface Card {
  messageId: string; status?: string; source?: string; items: Item[]; empty?: boolean; dismissed?: boolean; already?: boolean;
  projectId?: string | null; projectName?: string | null; projectLevel?: string; label?: string; createdTaskIds?: string[];
  projects?: { id: string; name: string }[]; users?: { id: string; name: string }[];
}
interface Source { kind: 'task' | 'meeting' | 'file' | 'message'; id: string; title: string; projectId?: string | null; taskId?: string | null; chatId?: string | null }
interface Ping { userId: string; name: string; taskId: string | null; title: string | null }
interface Answer {
  question: string; kind: string; source: string; lines: { text: string; sources: Source[] }[]; noData: boolean;
  text: string | null; reply: string | null; remind: Ping[]; ask: Ping | null;
}
type Draft = { title: string; assigneeId: string; deadline: string; linkTaskId: string; skip: boolean };

const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', marginTop: 6, background: 'var(--bg-elev)', fontSize: 13, maxWidth: 560 };
const head: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 };
const rowS: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 };
const lack: React.CSSProperties = { background: 'var(--warn-soft)', border: '1px solid var(--warn-line)', borderRadius: 6 };
const field: React.CSSProperties = { font: 'inherit', fontSize: 12, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', maxWidth: 200 };
const linkBtn: React.CSSProperties = { background: 'none', border: 0, padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit', textAlign: 'left' };

/* Лёгкие признаки — чтобы не спрашивать сервер про каждое сообщение. Решает всё равно сервер. */
const ASSIGN_HINT = /(?:^|[\s,.(«"])(?:@\S+|нужно|надо|необходимо|прошу|поручаю|пусть|сделай(?:те)?|подготовь(?:те)?|проверь(?:те)?|напиши(?:те)?|отправь(?:те)?|обнови(?:те)?|поправь(?:те)?|исправь(?:те)?|добавь(?:те)?|загрузи(?:те)?|собери(?:те)?|позвони(?:те)?|созвонись|посмотри(?:те)?|займись|возьми(?:те)?|сделаю|подготовлю)(?=[\s,.!?:;»"]|$)|^[А-ЯЁ][а-яё]+\s*[,—–-]\s*[а-яё]{3,}(?:й|йте|и|ите|ь|ьте)(?=[\s,.!?]|$)|\n\s*(?:\d{1,2}[.)]|[-•*])\s+\S/u;
const QUESTION_HINT = /(?:кто\s+(?:у\s+нас\s+)?(?:делает|сделает|отвечает|занимается|ведёт|ведет|должен|будет)|(?:я|мне)\s+(?:что\s+)?(?:должен|должна|надо|нужно)|должн[аы]?\s+ли\s+я|на\s+ком|чья\s+(?:это\s+)?задача|где\s+(?:\S+\s+){0,3}(?:лежит|лежат|файл|документ|ссылк|макет|тз|найти)|кто\s+за\s+это)/iu;
const RECENT_MS = 7 * 24 * 3600 * 1000;

/** Один разбор на сообщение за сеанс: лента перерисовывается часто. */
const autoCache = new Map<string, Promise<Card | null>>();

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const dm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');

function openSource(s: Source) {
  if (s.kind === 'task') navigate(s.projectId ? { section: 'projects', projectId: String(s.projectId), taskId: s.id } : { section: 'projects' });
  else if (s.kind === 'meeting') navigate({ section: 'chat', view: 'meetings', meetingId: s.id });
  else if (s.kind === 'file' && s.taskId) navigate(s.projectId ? { section: 'projects', projectId: String(s.projectId), taskId: String(s.taskId) } : { section: 'projects' });
  else if (s.chatId) navigate({ section: 'chat', chatId: String(s.chatId) });
}
const sourceLabel = (s: Source) => (s.kind === 'task' ? `#${s.id} «${s.title}»` : s.kind === 'meeting' ? `встреча «${s.title}»` : `файл «${s.title}»`);

export default function MessageActions({ messageId, body, isAi, createdAt, mode, onClose }: {
  messageId: string;
  body: string;
  isAi?: boolean;
  createdAt?: string | null;
  /** Открыто из меню сообщения: «Поручения → задачи» или «Спросить про контекст». */
  mode: 'tasks' | 'ask' | null;
  onClose: () => void;
}) {
  const recent = !createdAt || Date.now() - new Date(createdAt).getTime() < RECENT_MS;
  const autoTasks = !isAi && recent && ASSIGN_HINT.test(body);
  const askHint = !isAi && QUESTION_HINT.test(body);
  const [card, setCard] = useState<Card | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardErr, setCardErr] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [askBusy, setAskBusy] = useState(false);
  const [askErr, setAskErr] = useState('');
  const [askOpen, setAskOpen] = useState(false);

  // п. 7, показ в ленте: карточка появляется сама, если сервер нашёл поручения
  useEffect(() => {
    if (!autoTasks || mode === 'tasks') return;
    let alive = true;
    if (!autoCache.has(messageId)) {
      autoCache.set(messageId, request<Card>('GET', `/chat-actions/messages/${messageId}/tasks?auto=1`).catch(() => null));
    }
    void autoCache.get(messageId)!.then((c) => { if (alive && c && c.items.length && !c.dismissed) setCard(c); });
    return () => { alive = false; };
  }, [messageId, autoTasks, mode]);

  // п. 7, из меню: разбор моделью, если она есть
  useEffect(() => {
    if (mode !== 'tasks') return;
    setCardBusy(true); setCardErr('');
    request<Card>('GET', `/chat-actions/messages/${messageId}/tasks`)
      .then((c) => { setCard(c); autoCache.set(messageId, Promise.resolve(c)); if (!c.items.length) setCardErr('Поручений в сообщении не нашёл — можно создать задачу вручную (палочка).'); })
      .catch((e) => setCardErr(err(e, 'Не удалось разобрать сообщение')))
      .finally(() => setCardBusy(false));
  }, [messageId, mode]);

  const ask = () => {
    setAskOpen(true); setAskBusy(true); setAskErr('');
    request<Answer>('POST', `/chat-actions/messages/${messageId}/ask`, {})
      .then((a) => { setAnswer(a); feedback('ai.completed'); })
      .catch((e) => setAskErr(err(e, 'Ответ не собрался')))
      .finally(() => setAskBusy(false));
  };
  useEffect(() => { if (mode === 'ask') ask(); }, [mode, messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeTasks = () => { setCard(null); setCardErr(''); if (mode === 'tasks') onClose(); };
  const closeAsk = () => { setAskOpen(false); setAnswer(null); setAskErr(''); if (mode === 'ask') onClose(); };

  const showCard = !!card && card.items.length > 0;
  return (
    <>
      {mode === 'tasks' && cardBusy && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Ищу поручения в сообщении…</div>}
      {cardErr && !showCard && (
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
          {cardErr} <button style={linkBtn} onClick={closeTasks}>Скрыть</button>
        </div>
      )}
      {showCard && <AssignmentCard card={card!} onChange={setCard} onClose={closeTasks} messageId={messageId} />}
      {askHint && !askOpen && mode !== 'ask' && (
        <button className="msg-act" style={{ marginTop: 4 }} onClick={(e) => { e.stopPropagation(); ask(); }} title="Ответ по задачам, ТЗ и протоколам встреч — увидите только вы">
          <Icon name="help" size={12} /> Кто за это отвечает? — ответ из контекста
        </button>
      )}
      {askOpen && (
        <ContextAnswer messageId={messageId} busy={askBusy} error={askErr} answer={answer} onClose={closeAsk} />
      )}
    </>
  );
}

/* ───────────────────────── п. 7: карточка поручений ───────────────────────── */

function AssignmentCard({ card, messageId, onChange, onClose }: { card: Card; messageId: string; onChange: (c: Card) => void; onClose: () => void }) {
  const init = () => Object.fromEntries(card.items.map((i) => [i.key, {
    title: i.title, assigneeId: i.assigneeId ?? '', deadline: i.deadline ?? '', linkTaskId: i.linkTaskId ?? i.suggestLink ?? '', skip: !!i.skip,
  }])) as Record<string, Draft>;
  const [draft, setDraft] = useState<Record<string, Draft>>(init);
  const [projectId, setProjectId] = useState(card.projectId ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(init()); setProjectId(card.projectId ?? ''); }, [card]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = card.items.filter((i) => !i.taskId);
  const done = card.items.filter((i) => i.taskId);
  const label = useMemo(() => {
    const left = open.filter((i) => !draft[i.key]?.skip);
    const link = left.filter((i) => draft[i.key]?.linkTaskId).length;
    const create = left.length - link;
    if (!create && !link) return 'Нечего создавать';
    return !link ? `Создать ${create}` : !create ? `Связать ${link}` : `Создать ${create} и связать ${link}`;
  }, [open, draft]);
  const set = (key: string, patch: Partial<Draft>) => setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  const users = card.users ?? [];
  const projects = card.projects ?? [];
  const projectUnsure = !projectId || card.projectLevel === 'MEDIUM' || card.projectLevel === 'LOW';

  const create = async () => {
    if (!projectId) { setError('Выберите проект — без него задачи не создать'); return; }
    setBusy(true); setError('');
    try {
      const res = await request<Card>('POST', `/chat-actions/messages/${messageId}/tasks`, {
        projectId,
        items: open.map((i) => {
          const d = draft[i.key];
          return { key: i.key, title: d.title.trim(), assigneeId: d.assigneeId || '', deadline: d.deadline || '', linkTaskId: d.linkTaskId || '', skip: d.skip };
        }),
      });
      onChange(res); setEditing(false); feedback('task.created');
    } catch (e) { setError(err(e, 'Задачи не создались — повторите, созданные не задвоятся')); }
    finally { setBusy(false); }
  };
  const dismiss = async () => {
    setBusy(true);
    await request('POST', `/chat-actions/messages/${messageId}/tasks/dismiss`).catch(() => undefined);
    setBusy(false); onClose();
  };

  if (!open.length) {
    return (
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={head}><Icon name="check-circle" size={13} /> <b>Задачи из сообщения</b>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Скрыть"><Icon name="close" size={12} /></button>
        </div>
        <div style={rowS}>
          {done.map((i) => (
            <button key={i.key} style={linkBtn} onClick={() => openSource({ kind: 'task', id: String(i.taskId), title: i.title, projectId: card.projectId })}>
              #{i.taskId} {i.title}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={box} onClick={(e) => e.stopPropagation()} role="group" aria-label="Поручения из сообщения">
      <div style={head}>
        <Icon name="sparkles" size={13} /> <b>Поручения из сообщения: {open.length}</b>
        <span className="dim" style={{ fontSize: 11 }}>{card.source === 'model' ? 'нашёл ИИ' : 'по словам сообщения'} · проверьте и подтвердите</span>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Скрыть"><Icon name="close" size={12} /></button>
      </div>
      <div style={rowS}>
        <span className="dim">Проект:</span>
        {projectUnsure || editing ? (
          <select style={{ ...field, ...(projectId ? {} : lack) }} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Проект">
            <option value="">— выберите проект —</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : <b>{card.projectName}</b>}
        {projectId && card.projectLevel === 'MEDIUM' && !editing && <span className="dim" style={{ fontSize: 11 }}>скорее всего этот — проверьте</span>}
      </div>
      <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {open.map((i) => {
          const d = draft[i.key];
          if (!d) return null;
          const needWho = !d.assigneeId;
          const needDue = !d.deadline;
          return (
            <li key={i.key} style={{ marginTop: 6, opacity: d.skip ? 0.5 : 1 }}>
              {editing ? (
                <input style={{ ...field, maxWidth: '100%', width: '100%' }} value={d.title} onChange={(e) => set(i.key, { title: e.target.value })} aria-label="Что сделать" />
              ) : <span style={{ textDecoration: d.skip ? 'line-through' : undefined }}>{d.title}</span>}
              <div style={rowS}>
                <Icon name="user" size={12} />
                {editing || needWho ? (
                  <select style={{ ...field, ...(needWho ? lack : {}) }} value={d.assigneeId} onChange={(e) => set(i.key, { assigneeId: e.target.value })} aria-label="Исполнитель">
                    <option value="">{i.assigneeHint ? `«${i.assigneeHint}» — кто это?` : 'кто сделает?'}</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                ) : <span>{users.find((u) => u.id === d.assigneeId)?.name ?? i.assignee}</span>}
                <Icon name="calendar" size={12} />
                {editing || needDue ? (
                  <input type="date" style={{ ...field, ...(needDue ? lack : {}) }} value={d.deadline} onChange={(e) => set(i.key, { deadline: e.target.value })} aria-label="Срок" />
                ) : <span>до {dm(d.deadline)}</span>}
                {editing && (
                  <label style={{ fontSize: 12 }}><input type="checkbox" checked={d.skip} onChange={(e) => set(i.key, { skip: e.target.checked })} /> не задача</label>
                )}
              </div>
              {i.similar.map((s) => (
                <div key={s.id} style={{ ...rowS, fontSize: 12 }}>
                  <span className="dim">похожая:</span>
                  <button style={linkBtn} onClick={() => openSource({ kind: 'task', id: s.id, title: s.title, projectId: s.projectId })}>#{s.id} «{s.title}»</button>
                  {s.closed && <span className="dim">(закрыта)</span>}
                  {d.linkTaskId === s.id ? (
                    <>
                      <b>— свяжу, а не продублирую</b>
                      <button style={linkBtn} onClick={() => set(i.key, { linkTaskId: '' })}>создать новую</button>
                    </>
                  ) : (
                    <button style={linkBtn} onClick={() => set(i.key, { linkTaskId: s.id })}>связать, а не дублировать</button>
                  )}
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      {done.length > 0 && (
        <div className="dim" style={{ ...rowS, fontSize: 12 }}>
          Уже: {done.map((i) => (
            <button key={i.key} style={linkBtn} onClick={() => openSource({ kind: 'task', id: String(i.taskId), title: i.title, projectId: card.projectId })}>#{i.taskId}</button>
          ))}
        </div>
      )}
      {error && <div className="error-text" style={{ marginTop: 4 }}>{error}</div>}
      <div style={rowS}>
        <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || label === 'Нечего создавать'} onClick={() => void create()}>
          <Icon name="check" size={12} /> {busy ? 'Создаю…' : label}
        </button>
        <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => setEditing((x) => !x)} aria-pressed={editing}>
          <Icon name="edit" size={12} /> {editing ? 'Готово' : 'Изменить'}
        </button>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void dismiss()}>Не задачи</button>
      </div>
    </div>
  );
}

/* ─────────────────────── п. 8: ответ из контекста ─────────────────────── */

function ContextAnswer({ messageId, busy, error, answer, onClose }: { messageId: string; busy: boolean; error: string; answer: Answer | null; onClose: () => void }) {
  const [sending, setSending] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const [fail, setFail] = useState('');
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setSending(key); setFail('');
    try { await fn(); setDone((d) => [...d, key]); feedback('action.confirmed'); } catch (e) { setFail(err(e, 'Не отправилось')); } finally { setSending(''); }
  };
  const ping = (p: Ping, kind: 'remind' | 'ask') => run(`${kind}:${p.userId}`, () => request('POST', `/chat-actions/messages/${messageId}/ping`, {
    userId: p.userId, taskId: p.taskId ?? '', kind, question: answer?.question,
  }));
  const first = (name: string) => name.split(/\s+/)[0];

  return (
    <div style={box} onClick={(e) => e.stopPropagation()} role="region" aria-label="Ответ из контекста">
      <div style={head}>
        <Icon name="help" size={13} /> <b>Ответ из контекста</b>
        <span className="dim" style={{ fontSize: 11 }}><Icon name="lock" size={10} /> видите только вы</span>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Закрыть"><Icon name="close" size={12} /></button>
      </div>
      {busy && <div className="dim">Смотрю задачи, ТЗ и протоколы встреч…</div>}
      {error && <div className="error-text">{error}</div>}
      {answer && !answer.noData && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {answer.lines.map((l, i) => (
            <li key={i} style={{ marginTop: 4 }}>
              {l.text}{' '}
              <span style={{ fontSize: 11 }}>
                {l.sources.map((s) => (
                  <button key={`${s.kind}:${s.id}`} style={{ ...linkBtn, marginRight: 6 }} onClick={() => openSource(s)} title="Открыть источник">
                    <Icon name={s.kind === 'meeting' ? 'video' : s.kind === 'file' ? 'paperclip' : 'link'} size={10} /> {sourceLabel(s)}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {answer?.noData && <div style={{ marginTop: 4 }}>{answer.text}</div>}
      {fail && <div className="error-text" style={{ marginTop: 4 }}>{fail}</div>}
      {answer && (
        <div style={rowS}>
          {answer.reply && (
            <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={!!sending || done.includes('reply')}
              onClick={() => void run('reply', () => request('POST', `/chat-actions/messages/${messageId}/answer`, { text: answer.reply }))}>
              <Icon name="send" size={12} /> {done.includes('reply') ? 'Отправлено в чат' : 'Ответить этим в чат'}
            </button>
          )}
          {answer.remind.map((p) => (
            <button key={p.userId} className="ui-btn ui-btn-outline ui-btn-sm" disabled={!!sending || done.includes(`remind:${p.userId}`)}
              onClick={() => void ping(p, 'remind')} title={p.title ? `Про «${p.title}»` : undefined}>
              <Icon name="bell" size={12} /> {done.includes(`remind:${p.userId}`) ? `Напомнил: ${first(p.name)}` : `Напомнить: ${first(p.name)}`}
            </button>
          ))}
          {answer.ask && (
            <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={!!sending || done.includes(`ask:${answer.ask.userId}`)}
              onClick={() => void ping(answer.ask!, 'ask')}
              title={answer.ask.taskId ? `Постановщик задачи #${answer.ask.taskId}` : undefined}>
              <Icon name="chat" size={12} /> {done.includes(`ask:${answer.ask.userId}`) ? 'Спросил' : `Спросить ${answer.ask.taskId ? 'автора задачи' : ''} ${first(answer.ask.name)}`.replace(/\s+/g, ' ')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
