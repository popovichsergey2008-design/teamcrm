import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError, request } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { navigate } from '../../lib/router';
import { extractQevoLinks } from '../../lib/qevo-links';
import './link-cards.css';

/** Ответ `POST /link-cards` (#4902, п. 3) — по карточке на ссылку, в том же порядке. */
type Card =
  | { kind: 'task' | 'meeting' | 'file'; key: string; hidden: true }
  | {
      kind: 'task'; key: string; id: string; projectId: string; path: string; hidden?: undefined;
      title: string; assigneeName: string | null; deadlineAt: string | null;
      status: string; stage: string; closed: boolean; comments: number;
      canAccept: boolean; canSetDeadline: boolean;
    }
  | {
      kind: 'meeting'; key: string; id: string; path: string; hidden?: undefined; title: string; at: string;
      durationSec: number | null; status: string; decisions: number; tasks: number;
    }
  | { kind: 'file'; key: string; id: string; path: string; hidden?: undefined; name: string; size: number; contentType: string }
  | { kind: 'sheet'; key: string; id: string; url: string; hidden?: undefined; title: string | null };

/*
  Общее хранилище карточек на всю ленту.

  Сообщений в ленте десятки, и у каждого своя ссылка: запрос на каждую положил бы
  чат при открытии. Поэтому компоненты только заявляют «мне нужна эта ссылка», а
  запросы склеиваются за 40 мс в один `POST /link-cards`. Ответ кладётся по адресу —
  одна и та же задача в десяти сообщениях спрашивается один раз.
*/
const cache = new Map<string, Card | null>();
const mounted = new Map<string, number>();
const inflight = new Set<string>();
const subs = new Set<() => void>();
let queue = new Set<string>();
let timer: number | null = null;
const BATCH = 60;

function notify() { subs.forEach((f) => f()); }

function flush() {
  timer = null;
  const urls = [...queue].slice(0, BATCH);
  queue = new Set([...queue].slice(BATCH));
  if (queue.size) schedule();
  if (!urls.length) return;
  urls.forEach((u) => inflight.add(u));
  request<{ items: (Card | null)[] }>('POST', '/link-cards', { urls })
    .then((r) => urls.forEach((u, i) => cache.set(u, r.items?.[i] ?? null)))
    // сеть упала — карточек просто нет, текст со ссылкой остаётся; следующий сигнал попробует снова
    .catch(() => urls.forEach((u) => { if (!cache.has(u)) cache.set(u, null); }))
    .finally(() => { urls.forEach((u) => inflight.delete(u)); notify(); });
}

function schedule() { if (timer == null) timer = window.setTimeout(flush, 40); }

function want(urls: string[], force = false) {
  for (const u of urls) if (force || (!cache.has(u) && !inflight.has(u))) queue.add(u);
  if (queue.size) schedule();
}

/*
  Живой статус: сервер на любое изменение задач шлёт склеенный сигнал `data.changed`
  с номерами проектов (#1531). Перечитываем только карточки задач этих проектов,
  которые сейчас на экране, — одним запросом. Личный сигнал приходит без проектов:
  тогда перечитываем все задачи на экране, их единицы.
*/
let live = false;
function ensureLive() {
  if (live) return;
  live = true;
  getSocket().on('data.changed', (p?: { projects?: string[]; events?: string[] }) => {
    if (!p?.events?.some((e) => /^(task\.|approval\.|board\.|column\.)/.test(e))) return;
    const projects = new Set((p.projects ?? []).map(String));
    const urls = [...mounted.keys()].filter((u) => {
      const c = cache.get(u);
      return c?.kind === 'task' && !c.hidden && (!projects.size || projects.has(c.projectId));
    });
    want(urls, true);
  });
}

function useCards(urls: string[]) {
  const [, setTick] = useState(0);
  const sig = urls.join('\n');
  useEffect(() => {
    if (!urls.length) return;
    ensureLive();
    const bump = () => setTick((t) => t + 1);
    subs.add(bump);
    urls.forEach((u) => mounted.set(u, (mounted.get(u) ?? 0) + 1));
    want(urls);
    return () => {
      subs.delete(bump);
      urls.forEach((u) => { const n = (mounted.get(u) ?? 1) - 1; if (n <= 0) mounted.delete(u); else mounted.set(u, n); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return urls.map((u) => cache.get(u));
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function deadlineText(iso: string) {
  const d = new Date(iso);
  return d.getHours() === 0 && d.getMinutes() === 0 ? dateFmt.format(d) : timeFmt.format(d);
}
function sizeText(n: number) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
function comments(n: number) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'комментарий' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'комментария' : 'комментариев';
  return `${n} ${w}`;
}
/** Срок по умолчанию — завтра в 18:00, в формате поля `datetime-local`. */
function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T18:00`;
}

function TaskCard({ c, url }: { c: Extract<Card, { kind: 'task'; title: string }>; url: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(tomorrow);
  const overdue = !c.closed && !!c.deadlineAt && new Date(c.deadlineAt).getTime() < Date.now();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); setPicking(false); want([url], true); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось — попробуйте ещё раз'); }
    finally { setBusy(false); }
  };
  // «Принять» — тем же решением, что в очереди проверки: закрывает и из проверки, и из согласования
  const accept = () => act(() => request('POST', `/review/${c.id}/decision`, { action: 'accept' }));
  const saveDeadline = () => act(() => {
    if (!when) throw new Error('Выберите дату');
    return request('POST', `/tasks/${c.id}/plan`, { deadlineAt: new Date(when).toISOString() });
  });

  return (
    <div className={`lc-card${c.closed ? ' lc-done' : ''}`}>
      <button type="button" className="lc-title" onClick={() => navigate(c.path)} title="Открыть задачу">
        <Icon name={c.closed ? 'check-circle' : 'board'} size={15} />
        <span>{c.title}</span>
      </button>
      <div className="lc-meta">
        <span className={`lc-chip${c.closed ? ' lc-chip-ok' : ''}`}>{c.status || 'без статуса'}</span>
        <span><Icon name="user" size={13} /> {c.assigneeName ?? 'без исполнителя'}</span>
        <span className={overdue ? 'lc-late' : ''}><Icon name="clock" size={13} /> {c.deadlineAt ? deadlineText(c.deadlineAt) : 'без срока'}</span>
        <span><Icon name="chat" size={13} /> {comments(c.comments)}</span>
      </div>
      <div className="lc-actions">
        <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => navigate(c.path)}>Открыть</button>
        {c.canAccept && <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={() => void accept()}>Принять</button>}
        {c.canSetDeadline && !picking && (
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={busy} onClick={() => setPicking(true)}>Поставить срок</button>
        )}
        {picking && (
          <span className="lc-pick">
            <input type="datetime-local" className="ui-input" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Срок задачи" />
            <button type="button" className="ui-btn ui-btn-sm" disabled={busy || !when} onClick={() => void saveDeadline()}>Сохранить</button>
            <button type="button" className="lc-link" onClick={() => setPicking(false)}>отмена</button>
          </span>
        )}
      </div>
      {err && <div className="lc-err" role="alert">{err}</div>}
    </div>
  );
}

function OneCard({ c, url }: { c: Card; url: string }) {
  if (c.hidden) {
    const what = c.kind === 'task' ? 'задаче' : c.kind === 'meeting' ? 'встрече' : 'файлу';
    return <div className="lc-card lc-hidden"><Icon name="lock" size={14} /> Нет доступа к {what}</div>;
  }
  if (c.kind === 'task') return <TaskCard c={c} url={url} />;
  if (c.kind === 'meeting') {
    const min = c.durationSec ? Math.max(1, Math.round(c.durationSec / 60)) : null;
    return (
      <div className="lc-card">
        <button type="button" className="lc-title" onClick={() => navigate(c.path)} title="Открыть встречу">
          <Icon name="video" size={15} /><span>{c.title}</span>
        </button>
        <div className="lc-meta">
          <span><Icon name="calendar" size={13} /> {timeFmt.format(new Date(c.at))}</span>
          {min && <span><Icon name="clock" size={13} /> {min} мин</span>}
          <span>решений: {c.decisions}</span>
          <span>задач: {c.tasks}</span>
        </div>
        <div className="lc-actions">
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => navigate(c.path)}>Открыть</button>
        </div>
      </div>
    );
  }
  if (c.kind === 'file') {
    /*
      Файл за авторизацией: голая ссылка дала бы 401 — качаем с токеном. Смотреть в окне
      даём то же, что и сервер (картинки без SVG и PDF): SVG — документ со скриптами, и
      открытый с нашего адреса он получил бы доступ к приложению. Остальное скачивается.
      Окно открываем сразу по нажатию: открытое после ожидания браузер блокирует.
    */
    const viewable = (c.contentType.startsWith('image/') && !c.contentType.includes('svg')) || c.contentType.startsWith('application/pdf');
    const open = () => {
      const w = viewable ? window.open('', '_blank') : null;
      api.authedBlob(c.path)
        .then((b) => {
          const u = URL.createObjectURL(b);
          if (w) w.location.href = u;
          else { const a = document.createElement('a'); a.href = u; a.download = c.name; a.click(); }
          window.setTimeout(() => URL.revokeObjectURL(u), 60_000);
        })
        .catch(() => w?.close());
    };
    return (
      <div className="lc-card">
        <button type="button" className="lc-title" onClick={open} title="Открыть файл">
          <Icon name="file" size={15} /><span>{c.name}</span>
        </button>
        <div className="lc-meta">
          <span>{sizeText(c.size)}</span>
          <span>{c.contentType.split(';')[0]}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="lc-card">
      <a className="lc-title" href={c.url} target="_blank" rel="noopener noreferrer">
        <Icon name="chart" size={15} /><span>{c.title ?? 'Google-таблица'}</span>
      </a>
      <div className="lc-meta"><span>Google-таблица{c.title ? '' : ' · название видно только по доступу'}</span></div>
    </div>
  );
}

/**
 * Живые карточки под сообщением (#4902, п. 3): задача, встреча, файл, Google-таблица.
 * Текст со ссылкой остаётся как был — карточка добавляется под ним, не больше трёх.
 */
export default function LinkCards({ text }: { text: string }) {
  const links = useMemo(() => extractQevoLinks(text, typeof window !== 'undefined' ? window.location.hostname : ''), [text]);
  const urls = useMemo(() => links.map((l) => l.url), [links]);
  const cards = useCards(urls);
  if (!cards.some(Boolean)) return null;
  return (
    <div className="lc-list">
      {cards.map((c, i) => (c ? <OneCard key={links[i].key} c={c} url={urls[i]} /> : null))}
    </div>
  );
}
