import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { ApiError, rawRequest } from '../lib/api';
import './client-chat.css';

/**
 * Клиент в чате без регистрации (#4902, п. 15) — страница `/cc/<ссылка>`, без входа.
 *
 * Клиент представляется один раз и дальше ходит по ключу гостевой сессии: видит ТОЛЬКО
 * этот разговор и статусы задач, которые ему открыли. Внутренние чаты, номера задач,
 * исполнители и проекты сюда не приходят — их отсекает сервер, а не эта страница.
 * «Позвонить» ведёт в созвон этого разговора обычным гостевым входом (комната ожидания,
 * предупреждение о записи, протокол).
 */

interface Info { valid: boolean; orgName?: string; title?: string; message?: string }
interface Msg { id: string; body: string; created_at: string; guest_name: string | null; author_name: string | null; mine: boolean; attachment: string | null; edited: boolean }
interface Task { title: string; status: string; statusLabel: string; deadline: string | null; overdue: boolean }

const POLL_MS = 5000;
const TASKS_MS = 60_000;

const call = <T,>(method: 'GET' | 'POST', path: string, body?: unknown) => rawRequest<T>(method, `/client-chat/public/${path}`, body, false);

function storageKey(token: string) { return `qevo.cc.${token.slice(0, 24)}`; }
function readSession(token: string): string | null {
  try { return localStorage.getItem(storageKey(token)); } catch { return null; }
}
function writeSession(token: string, v: string | null) {
  try { if (v) localStorage.setItem(storageKey(token), v); else localStorage.removeItem(storageKey(token)); } catch { /* приватное окно — сессия живёт до перезагрузки */ }
}

const time = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString('ru-RU', today ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export default function ClientChatApp() {
  const token = decodeURIComponent(location.pathname.slice('/cc/'.length)).replace(/\/+$/, '');
  const [info, setInfo] = useState<Info | null>(null);
  const [session, setSession] = useState<string | null>(() => readSession(token));
  const [fatal, setFatal] = useState('');

  useEffect(() => {
    document.title = 'Разговор';
    call<Info>('GET', encodeURIComponent(token))
      .then((i) => { setInfo(i); if (i.title) document.title = i.title; })
      .catch((e) => setFatal(e instanceof ApiError ? e.message : 'Нет связи с сервером'));
  }, [token]);

  const drop = useCallback((message: string) => { writeSession(token, null); setSession(null); setFatal(message); }, [token]);

  if (fatal && !session) return <Shell><p className="cc-err">{fatal}</p></Shell>;
  if (!info) return <Shell><p className="cc-dim">Открываю разговор…</p></Shell>;
  if (!info.valid) return <Shell><h1>Ссылка не открывается</h1><p className="cc-dim">{info.message}</p></Shell>;
  if (!session) {
    return <JoinForm token={token} info={info} onJoined={(s) => { writeSession(token, s); setSession(s); setFatal(''); }} />;
  }
  return <Conversation info={info} session={session} onLost={drop} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="cc"><div className="cc-card">{children}</div></div>;
}

function JoinForm({ token, info, onJoined }: { token: string; info: Info; onJoined: (session: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const join = async () => {
    setBusy(true); setErr('');
    try {
      const r = await call<{ session: string }>('POST', `${encodeURIComponent(token)}/join`, { name: name.trim(), email: email.trim() || undefined });
      onJoined(r.session);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось войти'); } finally { setBusy(false); }
  };
  return (
    <Shell>
      <p className="cc-dim">{info.orgName} приглашает вас в разговор</p>
      <h1>{info.title}</h1>
      <p className="cc-dim">Регистрация не нужна. Вы увидите только этот разговор и статусы задач, которые вам открыли.</p>
      <form className="cc-form" onSubmit={(e) => { e.preventDefault(); if (name.trim().length >= 2) void join(); }}>
        <label>Как вас зовут
          <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus autoComplete="name" placeholder="Имя и компания" />
        </label>
        <label>Почта — по желанию
          <input className="ui-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} autoComplete="email" />
        </label>
        {err && <p className="cc-err">{err}</p>}
        <button className="ui-btn ui-btn-primary" type="submit" disabled={busy || name.trim().length < 2}>
          <Icon name="chat" size={15} /> {busy ? 'Вхожу…' : 'Войти в разговор'}
        </button>
      </form>
    </Shell>
  );
}

function Conversation({ info, session, onLost }: { info: Info; session: string; onLost: (message: string) => void }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [tasks, setTasks] = useState<{ tasks: Task[]; summary: string } | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [calling, setCalling] = useState(false);
  const [err, setErr] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);
  const lastId = useRef<string | null>(null);

  const fail = useCallback((e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.code === 'UNAUTHORIZED') onLost(e.message);
    else setErr(e instanceof ApiError ? e.message : fallback);
  }, [onLost]);

  const load = useCallback(() => {
    call<Msg[]>('POST', 'session/messages', { session, afterId: lastId.current ?? undefined })
      .then((rows) => {
        if (!rows.length) return;
        lastId.current = rows[rows.length - 1].id;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...rows.filter((m) => !seen.has(m.id))];
        });
      })
      .catch((e) => fail(e, 'Нет связи с сервером'));
  }, [session, fail]);

  const loadTasks = useCallback(() => {
    call<{ tasks: Task[]; summary: string }>('POST', 'session/tasks', { session }).then(setTasks).catch((e) => fail(e, 'Задачи не загрузились'));
  }, [session, fail]);

  useEffect(() => {
    load(); loadTasks();
    const a = window.setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const b = window.setInterval(() => { if (!document.hidden) loadTasks(); }, TASKS_MS);
    return () => { window.clearInterval(a); window.clearInterval(b); };
  }, [load, loadTasks]);

  useEffect(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBody(''); setBusy(true); setErr('');
    try {
      const m = await call<Msg>('POST', 'session/send', { session, body: text });
      lastId.current = lastId.current && Number(lastId.current) > Number(m.id) ? lastId.current : m.id;
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    } catch (e) { setBody(text); fail(e, 'Сообщение не отправлено'); } finally { setBusy(false); }
  };

  const callUs = async () => {
    setCalling(true); setErr('');
    // окно открываем сразу, до ответа сервера: иначе браузер посчитает его всплывающим и закроет
    const win = window.open('', '_blank');
    try {
      const r = await call<{ url: string }>('POST', 'session/call', { session });
      if (win) win.location.href = r.url; else location.href = r.url;
    } catch (e) { win?.close(); fail(e, 'Созвон сейчас недоступен'); } finally { setCalling(false); }
  };

  return (
    <div className="cc cc-wide">
      <div className="cc-layout">
        <section className="cc-chat" aria-label="Переписка">
          <header className="cc-head">
            <div className="cc-head-main">
              <span className="cc-dim">{info.orgName}</span>
              <b>{info.title}</b>
            </div>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void callUs()} disabled={calling} title="Созвон с командой: запись и протокол — по вашему согласию">
              <Icon name="phone" size={14} /> {calling ? 'Соединяю…' : 'Позвонить'}
            </button>
          </header>
          <div className="cc-feed" ref={feedRef} aria-live="polite">
            {messages.length === 0 && <p className="cc-dim cc-empty">Здесь будет переписка. Напишите первым — вам ответят.</p>}
            {messages.map((m) => (
              <div key={m.id} className={`cc-msg ${m.mine ? 'cc-mine' : ''}`}>
                <div className="cc-author">{m.mine ? 'Вы' : (m.author_name ?? m.guest_name ?? 'Сотрудник')}</div>
                {m.body && <div className="cc-body">{m.body}</div>}
                {m.attachment && <div className="cc-dim"><Icon name="paperclip" size={12} /> {m.attachment}</div>}
                <div className="cc-time">{time(m.created_at)}{m.edited ? ' · изменено' : ''}</div>
              </div>
            ))}
          </div>
          {err && <p className="cc-err cc-pad">{err}</p>}
          <form className="cc-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <textarea
              className="ui-input" rows={2} value={body} maxLength={4000} placeholder="Сообщение…" aria-label="Сообщение"
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            <button className="ui-btn ui-btn-primary" type="submit" disabled={busy || !body.trim()} aria-label="Отправить"><Icon name="send" size={15} /></button>
          </form>
        </section>
        <aside className="cc-side" aria-label="Статусы задач">
          <h2>Статусы задач</h2>
          {!tasks && <p className="cc-dim">Загружаю…</p>}
          {tasks && !tasks.tasks.length && <p className="cc-dim">Задачи вам пока не открыли — спросите в чате.</p>}
          {tasks && tasks.tasks.length > 0 && (
            <>
              <p className="cc-sum">{tasks.summary}</p>
              <ul className="cc-tasks">
                {tasks.tasks.map((t, i) => (
                  <li key={i} className={`cc-task cc-st-${t.status}`}>
                    <span className="cc-task-title">{t.title}</span>
                    <span className="cc-task-meta">
                      <span className="cc-chip">{t.statusLabel}</span>
                      {t.deadline && t.status !== 'done' && <span className={t.overdue ? 'cc-late' : ''}>срок {day(t.deadline)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="cc-dim cc-note">Вы видите только этот разговор. Внутренняя переписка команды сюда не попадает.</p>
        </aside>
      </div>
    </div>
  );
}
