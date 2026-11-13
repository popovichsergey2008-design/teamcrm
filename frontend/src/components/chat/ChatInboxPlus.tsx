import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../../lib/api';
import { feedback } from '../../lib/feedback';
import { Icon } from '../Icon';

const MessageToTask = lazy(() => import('../MessageToTask').then((m) => ({ default: m.MessageToTask })));

interface Item { messageId: string; chatId: string; chatKind: string; chatTitle: string | null; author: string; body: string; ago: string; threadRootId: string | null }
interface Missed {
  messages: number; chats: number; text: string; waiting: Item[];
  lines: { chatId: string; chat: string; text: string; messageId: string | null }[];
  decisions: { text: string; chatId: string; messageId: string }[];
  todo: { text: string; chatId: string; messageId: string }[];
}
type Open = (hit: { chatId: string; messageId: string; threadRootId: string | null }) => void;

const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', margin: '6px 0', background: 'var(--card)' };
const row: React.CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 };
const ref: React.CSSProperties = { background: 'none', border: 0, padding: 0, color: 'var(--primary)', cursor: 'pointer', font: 'inherit', textAlign: 'left' };

/**
 * «Входящие» чатов по ТЗ #4902. п. 5 — «Что я пропустил» за 30 секунд: темы по всем
 * чатам с момента последнего захода, решения и что ждут от вас, у каждой строки —
 * переход к исходному сообщению, «Прослушать». п. 6 — «Ждут вашего ответа»: вопросы
 * к вам без ответа дольше 4 ч с черновиком (Отправить / Изменить / Создать задачу /
 * Не мне) и «Мои вопросы без ответа» с «Напомнить». Без нажатия ничего не уходит.
 */
export default function ChatInboxPlus({ missedTick, onOpen, onTaskCreated }: {
  /** Растёт при нажатии «Что я пропустил» в шапке «Входящих». */
  missedTick: number;
  onOpen: Open;
  onTaskCreated: (taskId: string, projectId: string) => void;
}) {
  const [missed, setMissed] = useState<Missed | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState<{ toMe: Item[]; mine: Item[] } | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const loadWaiting = () => void request<{ toMe: Item[]; mine: Item[] }>('GET', '/chat-plus/waiting').then(setWaiting).catch(() => undefined);
  useEffect(loadWaiting, []);
  useEffect(() => () => { audio.current?.pause(); }, []);
  useEffect(() => {
    if (!missedTick) return;
    setBusy(true); setErr('');
    request<Missed>('GET', '/chat-plus/missed')
      .then((m) => { setMissed(m); setWaiting((w) => (w ? { ...w, toMe: m.waiting } : w)); feedback('ai.completed'); })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Сводка не собралась'))
      .finally(() => setBusy(false));
  }, [missedTick]);

  const listen = async () => {
    if (!missed) return;
    if (playing) { audio.current?.pause(); setPlaying(false); return; }
    setPlaying(true);
    try {
      const a = await request<{ mime: string; base64: string }>('POST', '/chat-plus/missed/listen', { text: missed.text });
      audio.current = new Audio(`data:${a.mime};base64,${a.base64}`);
      audio.current.onended = () => setPlaying(false);
      await audio.current.play();
    } catch (e) { setPlaying(false); setErr(e instanceof ApiError ? e.message : 'Озвучка недоступна'); }
  };

  const go = (chatId: string, messageId: string | null, threadRootId: string | null = null) => {
    if (messageId) onOpen({ chatId, messageId, threadRootId });
  };

  return (
    <>
      {busy && <div className="dim" style={{ fontSize: 13, margin: '6px 0' }}>Читаю непрочитанное…</div>}
      {err && <div className="error-text">{err}</div>}
      {missed && (
        <div className="ai-digest">
          <div className="ai-digest-head">
            <Icon name="sparkles" size={13} /> <b>Что вы пропустили</b>
            <span className="dim" style={{ fontSize: 12 }}>{missed.messages ? `${missed.messages} сообщ. · ${missed.chats} чат.` : ''}</span>
            {missed.messages > 0 && (
              <button className="msg-act" onClick={() => void listen()} aria-pressed={playing}>
                <Icon name={playing ? 'pause' : 'volume'} size={12} /> {playing ? 'Стоп' : 'Прослушать'}
              </button>
            )}
            <button className="msg-act" onClick={() => setMissed(null)}>Скрыть</button>
          </div>
          {!missed.messages && <div className="ai-digest-body">{missed.text}</div>}
          {missed.lines.map((l, i) => (
            <div key={i} style={{ margin: '4px 0', fontSize: 13 }}>
              <button style={ref} onClick={() => go(l.chatId, l.messageId)} title="Перейти к сообщению"><b>{l.chat}</b></button>
              {' — '}{l.text}
            </div>
          ))}
          {missed.decisions.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <b>Решения</b>
              {missed.decisions.map((d, i) => (
                <div key={i}>• <button style={ref} onClick={() => go(d.chatId, d.messageId)}>{d.text}</button></div>
              ))}
            </div>
          )}
          {missed.todo.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <b>Ждут от вас</b>
              {missed.todo.map((d, i) => (
                <div key={i}>• <button style={ref} onClick={() => go(d.chatId, d.messageId)}>{d.text}</button></div>
              ))}
            </div>
          )}
        </div>
      )}

      {waiting && waiting.toMe.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}><Icon name="clock" size={13} /> Ждут вашего ответа · {waiting.toMe.length}</div>
          {waiting.toMe.map((it) => (
            <WaitingCard key={it.messageId} it={it} onOpen={go} onTaskCreated={onTaskCreated}
              onDone={() => setWaiting((w) => (w ? { ...w, toMe: w.toMe.filter((x) => x.messageId !== it.messageId) } : w))} />
          ))}
        </div>
      )}

      {waiting && waiting.mine.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Мои вопросы без ответа · {waiting.mine.length}</div>
          {waiting.mine.map((it) => (
            <MineCard key={it.messageId} it={it} onOpen={go}
              onDone={() => setWaiting((w) => (w ? { ...w, mine: w.mine.filter((x) => x.messageId !== it.messageId) } : w))} />
          ))}
        </div>
      )}
    </>
  );
}

function Head({ it, onOpen }: { it: Item; onOpen: (chatId: string, messageId: string, threadRootId: string | null) => void }) {
  return (
    <div style={{ fontSize: 13 }}>
      <button style={ref} onClick={() => onOpen(it.chatId, it.messageId, it.threadRootId)} title="Открыть переписку">
        <b>{it.chatKind === 'dm' ? it.author : `${it.chatTitle ?? 'Чат'} · ${it.author}`}</b>
      </button>
      <span className="dim"> · {it.ago} назад</span>
      <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{it.body}</div>
    </div>
  );
}

function WaitingCard({ it, onOpen, onDone, onTaskCreated }: {
  it: Item; onOpen: (chatId: string, messageId: string, threadRootId: string | null) => void; onDone: () => void;
  onTaskCreated: (taskId: string, projectId: string) => void;
}) {
  const [draft, setDraft] = useState<{ text: string; sources: { id: string; projectId: string; title: string }[] } | null>(null);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [toTask, setToTask] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  const id = encodeURIComponent(it.messageId);
  return (
    <div style={box}>
      <Head it={it} onOpen={onOpen} />
      {draft && (
        <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 8, background: 'var(--muted)' }}>
          <div className="dim" style={{ fontSize: 11 }}>Черновик ответа — уйдёт только по кнопке «Отправить»</div>
          {edit
            ? <textarea className="ui-input" rows={3} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} style={{ width: '100%', marginTop: 4 }} aria-label="Текст ответа" />
            : <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{draft.text}</div>}
          {draft.sources.length > 0 && (
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
              Источники: {draft.sources.map((s) => <a key={s.id} href={`/projects/${s.projectId}/task/${s.id}`} target="_blank" rel="noreferrer" style={{ marginRight: 6 }}>#{s.id} {s.title}</a>)}
            </div>
          )}
        </div>
      )}
      <div style={row}>
        {!draft
          ? <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void act(async () => setDraft(await request('POST', `/chat-plus/waiting/${id}/draft`)))}>
              <Icon name="sparkles" size={12} /> {busy ? 'Пишу…' : 'Черновик ответа'}
            </button>
          : <>
              <button className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !draft.text.trim()}
                onClick={() => void act(async () => { await request('POST', `/chat-plus/waiting/${id}/reply`, { text: draft.text }); feedback('action.confirmed'); onDone(); })}>Отправить</button>
              <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setEdit((v) => !v)}>{edit ? 'Готово' : 'Изменить'}</button>
            </>}
        <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setToTask(true)}>Создать задачу</button>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void act(async () => { await request('POST', `/chat-plus/waiting/${id}/dismiss`); onDone(); })}>Не мне</button>
      </div>
      {err && <div className="error-text">{err}</div>}
      {toTask && (
        <Suspense fallback={null}><MessageToTask chatId={it.chatId} messageId={it.messageId} messageText={it.body}
          onClose={() => setToTask(false)}
          onCreated={(taskId, _title, projectId) => { setToTask(false); onDone(); onTaskCreated(String(taskId), String(projectId)); }} /></Suspense>
      )}
    </div>
  );
}

function MineCard({ it, onOpen, onDone }: { it: Item; onOpen: (chatId: string, messageId: string, threadRootId: string | null) => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const id = encodeURIComponent(it.messageId);
  const run = async (path: string) => {
    setBusy(true); setErr('');
    try { await request('POST', `/chat-plus/waiting/${id}/${path}`); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  return (
    <div style={box}>
      <Head it={{ ...it, author: it.chatKind === 'dm' ? (it.chatTitle ?? 'Диалог') : 'вы' }} onOpen={onOpen} />
      <div style={row}>
        <button className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => void run('remind')}>Напомнить</button>
        <button className="ui-btn ui-btn-ghost ui-btn-sm" disabled={busy} onClick={() => void run('dismiss')}>Уже не нужно</button>
      </div>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
