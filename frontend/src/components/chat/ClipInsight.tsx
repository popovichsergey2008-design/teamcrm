import { useEffect, useReducer, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError, request } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { navigate } from '../../lib/router';
import { OptionSelect } from '../ui/option-select';
import './clip-insight.css';

interface Segment { start: number; end: number; text: string }
interface Mark { sec: number; label: string; text: string }
interface Insight {
  messageId: string; kind: 'voice' | 'screen'; status: 'running' | 'ready' | 'failed';
  summary: string | null; summaryBy: 'model' | 'rules' | null; segments: Segment[]; marks: Mark[];
  durationSec: number | null; readyMs: number | null; bugTaskId: string | null;
}

// ───── загрузка пачкой: в ленте десяток голосовых — один запрос, а не десять ─────

const cache = new Map<string, Insight | null>();
const subs = new Map<string, Set<() => void>>();
const queue = new Set<string>();
let timer: number | undefined;
let speech: boolean | null = null;
let bound = false;

const notify = (id: string) => subs.get(id)?.forEach((f) => f());

function flush() {
  timer = undefined;
  const ids = [...queue];
  queue.clear();
  if (!ids.length) return;
  request<{ items: Insight[]; speech: boolean }>('GET', `/clip-insight?ids=${ids.join(',')}`)
    .then((r) => {
      speech = r.speech;
      for (const id of ids) { cache.set(id, r.items.find((x) => x.messageId === id) ?? null); notify(id); }
    })
    .catch(() => { for (const id of ids) { cache.set(id, null); notify(id); } });
}

function want(id: string, force = false) {
  if (!force && cache.has(id)) return;
  queue.add(id);
  if (timer === undefined) timer = window.setTimeout(flush, 40);
}

function bind() {
  if (bound) return;
  bound = true;
  // разбор готов — приходит событием тем же участникам, что и расшифровка
  getSocket().on('chat.clip.insight', (p: { messageId: string; insight: Insight }) => {
    if (!p?.messageId) return;
    cache.set(String(p.messageId), p.insight);
    notify(String(p.messageId));
  });
}

function useInsight(messageId: string, transcript: string | null | undefined) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    bind();
    let set = subs.get(messageId);
    if (!set) { set = new Set(); subs.set(messageId, set); }
    set.add(tick);
    want(messageId);
    return () => { set!.delete(tick); };
  }, [messageId]);
  // текст пришёл, а разбора в кэше нет (событие разминулось) — спросим ещё раз
  useEffect(() => {
    if (transcript && cache.get(messageId) === null) want(messageId, true);
  }, [messageId, transcript]);
  return cache.get(messageId) ?? null;
}

const stamp = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

/**
 * #4902, п. 14 «Видео и голос → текст и задачи» — под голосовым и записью экрана.
 *
 * Голосовое: кратко в 1–2 строки, «Текст целиком», «Ответить голосом».
 * Запись экрана: кратко, метки времени («0:42 баг» — по нажатию видео встаёт на момент),
 * текст с метками и «Создать задачу-баг с видео» (проект выбирает человек).
 * Пока идёт расшифровка, «Расшифровываю…» показывает сама лента.
 */
export default function ClipInsight({ chatId, messageId, kind, transcript, status, onVoiceReply }: {
  chatId: string; messageId: string; kind: 'voice' | 'screen';
  transcript: string | null | undefined; status: string | null | undefined;
  onVoiceReply?: () => void;
}) {
  const ins = useInsight(messageId, transcript);
  const [full, setFull] = useState<boolean | null>(null);
  const [bug, setBug] = useState(false);
  const [created, setCreated] = useState<{ taskId: string; title: string; projectId: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const running = status === 'running';
  const summary = ins?.summary && ins.summary !== transcript ? ins.summary : null;
  const segments = ins?.segments ?? [];
  const marks = ins?.marks ?? [];

  const seek = (sec: number) => {
    const video = root.current?.closest('.chat-msg')?.querySelector('video');
    if (!video) return;
    video.currentTime = sec;
    void video.play().catch(() => undefined);
  };

  // короткое голосовое без «кратко» читается целиком сразу; с «кратко» — по кнопке
  const showFull = full ?? (kind === 'voice' && !summary);
  const text = transcript && transcript.trim() ? transcript : null;

  return (
    <div className="clipi" ref={root}>
      {summary && (
        <div className="clipi-summary">
          <Icon name="sparkles" size={13} /> <span>{summary}</span>
        </div>
      )}

      {kind === 'screen' && marks.length > 0 && (
        <div className="clipi-marks" aria-label="Метки времени">
          {marks.map((k) => (
            <button key={k.sec} type="button" className={`clipi-mark${k.label === 'баг' ? ' is-bug' : ''}`} onClick={() => seek(k.sec)}
              title={`Перейти к ${stamp(k.sec)}`}>
              <b>{stamp(k.sec)}</b> {k.label}: {k.text}
            </button>
          ))}
        </div>
      )}

      {/* у голосового текст — здесь (с расставленными знаками); у записи экрана он уже в теле — здесь с метками времени */}
      {showFull && kind === 'voice' && text && <div className="clipi-full">{text}</div>}
      {showFull && kind === 'screen' && segments.length > 0 && (
        <div className="clipi-full">
          {segments.map((s, i) => (
            <div key={i}>
              <button type="button" className="clipi-ts" onClick={() => seek(s.start)}>{stamp(s.start)}</button> {s.text}
            </div>
          ))}
        </div>
      )}

      <div className="clipi-actions">
        {(kind === 'voice' ? !!text && !!summary : segments.length > 0) && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setFull(!showFull)} aria-expanded={showFull}>
            <Icon name={showFull ? 'chevron-up' : 'file'} size={14} /> {showFull ? 'Свернуть текст' : kind === 'screen' ? 'Текст с метками времени' : 'Текст целиком'}
          </button>
        )}
        {kind === 'voice' && onVoiceReply && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onVoiceReply} title="Записать голосовое ответом на это сообщение">
            <Icon name="mic" size={14} /> Ответить голосом
          </button>
        )}
        {kind === 'screen' && !running && (created || ins?.bugTaskId) ? (
          <span className="clipi-dim">
            <Icon name="check" size={13} /> Задача-баг создана
            {created && <> · <button type="button" className="clipi-link" onClick={() => navigate(`/projects/${created.projectId}/task/${created.taskId}`)}>открыть</button></>}
          </span>
        ) : kind === 'screen' && !running && (
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => setBug(!bug)} aria-expanded={bug}>
            <Icon name="alert" size={14} /> Создать задачу-баг с видео
          </button>
        )}
      </div>

      {!running && !text && speech === false && (
        <div className="clipi-dim">Расшифровка недоступна: не подключён ИИ для речи.</div>
      )}
      {ins?.summaryBy === 'rules' && summary && <div className="clipi-dim">Кратко — по первым фразам: модель ИИ не подключена.</div>}

      {bug && !created && (
        <BugForm chatId={chatId} messageId={messageId} onDone={(r) => { setCreated(r); setBug(false); }} onCancel={() => setBug(false)} />
      )}
    </div>
  );
}

/** Задача-баг с видео: проект обязателен, название и описание — из расшифровки, правятся. */
function BugForm({ messageId, onDone, onCancel }: {
  chatId: string; messageId: string;
  onDone: (r: { taskId: string; title: string; projectId: string }) => void; onCancel: () => void;
}) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.listProjects().catch(() => []),
      request<{ title: string; description: string; projectId: string | null }>('GET', `/clip-insight/${messageId}/bug-draft`),
    ]).then(([list, d]) => {
      if (!alive) return;
      const ps = (list as { id: string | number; name: string }[]).map((p) => ({ id: String(p.id), name: p.name }));
      setProjects(ps);
      setTitle(d.title);
      setDescription(d.description);
      // проект чата подставляем, только если он среди доступных; иначе выбирает человек
      if (d.projectId && ps.some((p) => p.id === String(d.projectId))) setProjectId(String(d.projectId));
    }).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось подготовить задачу'));
    return () => { alive = false; };
  }, [messageId]);

  const submit = async () => {
    if (!projectId) { setErr('Выберите проект'); return; }
    setBusy(true); setErr('');
    try {
      onDone(await request('POST', `/clip-insight/${messageId}/bug-task`, { projectId, title, description }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Задача не создалась');
    } finally { setBusy(false); }
  };

  return (
    <div className="clipi-form">
      <label className="clipi-field">
        <span>Проект <span aria-hidden="true">*</span></span>
        <OptionSelect className="input" value={projectId} onChange={(e) => setProjectId(String(e.target.value))} aria-required aria-label="Проект задачи">
          <option value="">— выберите проект —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </OptionSelect>
      </label>
      <label className="clipi-field">
        <span>Название</span>
        <input className="input" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="clipi-field">
        <span>Описание — из расшифровки, видео приложится к задаче</span>
        <textarea className="input" rows={5} value={description} maxLength={9000} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {err && <div className="error-text">{err}</div>}
      <div className="clipi-actions">
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void submit()} disabled={busy || !title.trim()}>
          {busy ? 'Создаю…' : 'Создать задачу-баг'}
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}
