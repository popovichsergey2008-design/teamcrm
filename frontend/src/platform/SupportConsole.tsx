import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { fmtDate, pc, PcError, tokenHeader } from './api';

interface QueueRow {
  id: string; subject: string | null; status: string; statusText: string; userName: string | null; orgName: string | null;
  requiredSkill: string | null; aiSummary: string | null; agentName: string | null; agentId: string | null;
  waitingSince: string; lastAt: string | null; priority: string;
}
interface Msg {
  id: string; kind: string; authorId: string | null; authorName: string | null; body: string;
  fileId: string | null; fileName: string | null; contentType: string | null; createdAt: string;
}
interface Client {
  company: string; isTest: boolean; members: number; plan: string | null;
  subscription: { status: string; text: string; until: string | null };
  ai: { state: 'own' | 'trial' | 'off'; text: string };
}
interface Conversation {
  id: string; subject: string | null; orgName: string | null; status: string; statusText: string; priority: string;
  agentId: string | null; me: string; createdAt: string; aiMode: string; aiSummary: string | null; handoffNote: string | null;
  csat: number | null; messages: Msg[]; client: Client | null;
  call: { id: string; byUserId: string; byName: string | null; byRole: string; at: string } | null;
  context: { route?: string | null; app_version?: string | null; browser?: string | null; os?: string | null; platform?: string | null;
    native_version?: string | null; device?: string | null; last_error?: string | null; network?: string | null } | null;
}
interface Note { id: string; authorName: string | null; body: string; createdAt: string }
interface Pass { token: string; iceServers: RTCIceServer[]; userId: string; roomId: string; name: string }
interface Grant { id: string; engineer: string | null; projectName: string | null; reason: string | null; status: string; requestedAt: string; expiresAt: string | null }
interface Snapshot {
  project: { name: string; visibility: string; owner_name: string | null; client_name: string | null } | null;
  columns: { name: string; tasks: number }[]; members: { full_name: string }[]; expiresAt: string;
}
interface Known { id: string; taskId: string; title: string; pattern: string; active: boolean; fixed: boolean }
interface Incident { id: string; title: string; message: string; started_at: string }

const GRANT_TEXT: Record<string, string> = { requested: 'ждёт решения клиента', granted: 'разрешён', declined: 'клиент отказал', revoked: 'клиент закрыл', expired: 'истёк' };

/** Созвон оператора открывается в CRM (там экран созвона): пропуск — во фрагменте адреса, на сервер он не уходит. */
function openCall(pass: Pass) {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(pass)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const host = window.location.hostname.startsWith('support.') ? window.location.hostname.replace(/^support\./, 'app.') : window.location.host;
  window.open(`${window.location.protocol}//${host}/meet/op#${b64}`, '_blank', 'noopener');
}

/** Ссылки в сообщениях — кликабельные: клиент присылает адрес созвона, если комнату поднял он. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return <>{parts.map((x, i) => (i % 2 ? <a key={i} href={x} target="_blank" rel="noopener noreferrer">{x}</a> : x))}</>;
}
interface Availability {
  engineers: { userId: string; name: string; status: string; statusText: string }[];
  available: number; medianSec: number | null;
}
interface Dashboard {
  summary: { total: number; active: number; waiting: number; resolved: number; firstResponseSeconds: number | null; queueWaitSeconds: number | null;
    resolutionSeconds: number | null; csatAvg: number | null; csatCount: number; reopened: number; solvedByAi: number; escalated: number };
}

type Filter = 'all' | 'none' | 'me';
const FILTERS: [Filter, string][] = [['all', 'Все открытые'], ['none', 'Без специалиста'], ['me', 'Мои']];
const STATUSES: [string, string][] = [['available', 'Свободен'], ['busy', 'Занят'], ['away', 'Отошёл']];
const dur = (s: number | null) => (s == null ? '—' : s < 90 ? `${s} с` : s < 5400 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`);
const ago = (iso: string) => dur(Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)));
const err = (e: unknown) => (e instanceof PcError ? e.message : 'Не получилось');

/**
 * Консоль поддержки (support.qevo.one, §6). Обращения всех компаний; оператор работает
 * под своей учёткой консоли. Сокета CRM здесь нет намеренно — сообщения рабочих чатов
 * сюда не попадают; очередь и открытый разговор консоль спрашивает сама.
 */
export default function SupportConsole() {
  const [tab, setTab] = useState<'queue' | 'known' | 'stats'>('queue');
  const [avail, setAvail] = useState<Availability | null>(null);
  const [status, setStatus] = useState<string>(() => { try { return localStorage.getItem('pc:support:status') ?? 'available'; } catch { return 'available'; } });

  // «Я на месте» — раз в 30 с, пока вкладка открыта: по нему клиенту честно показывают, есть ли кто
  useEffect(() => {
    let alive = true;
    const beat = (s?: string) => pc<Availability>('POST', '/pc/support/presence', s ? { status: s } : {})
      .then((a) => { if (alive) setAvail(a); }).catch(() => undefined);
    void beat(status);
    const t = window.setInterval(() => { if (!document.hidden) void beat(); }, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [status]);

  const pick = (s: string) => { setStatus(s); try { localStorage.setItem('pc:support:status', s); } catch { /* приватный режим */ } };

  return (
    <>
      <div className="pc-row pc-wrap pc-between pc-sup-bar">
        <nav className="pc-tabs pc-h-flat" aria-label="Разделы">
          <button type="button" className="pc-tab" aria-pressed={tab === 'queue'} onClick={() => setTab('queue')}>Обращения</button>
          <button type="button" className="pc-tab" aria-pressed={tab === 'known'} onClick={() => setTab('known')}>Известные проблемы и сбой</button>
          <button type="button" className="pc-tab" aria-pressed={tab === 'stats'} onClick={() => setTab('stats')}>Сводка</button>
        </nav>
        <div className="pc-row pc-wrap">
          <span className="dim">Мой статус:</span>
          <div className="pc-seg" role="group" aria-label="Мой статус">
            {STATUSES.map(([k, l]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => pick(k)}>{l}</button>)}
          </div>
          {avail && <span className="dim">Свободно специалистов: {avail.available}</span>}
        </div>
      </div>
      {tab === 'queue' ? <Queue /> : tab === 'known' ? <KnownAndIncident /> : <Stats avail={avail} />}
    </>
  );
}

function Queue() {
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [e, setE] = useState('');

  const load = useCallback(() => pc<QueueRow[]>('GET', `/pc/support/queue${filter === 'all' ? '' : `?assigned=${filter}`}`)
    .then((r) => { setRows(r); setE(''); }).catch((x) => setE(err(x))), [filter]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  return (
    <div className="pc-sup">
      <section className="pc-sup-list" aria-label="Очередь">
        <div className="pc-seg" role="group" aria-label="Отбор">
          {FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        {e && <p className="pc-err pc-gap">{e}</p>}
        {!rows && !e && <p className="dim">Загрузка…</p>}
        {rows?.length === 0 && <p className="dim pc-gap">Обращений нет.</p>}
        <ul className="pc-sup-rows">
          {rows?.map((r) => (
            <li key={r.id}>
              <button type="button" className={`pc-sup-row${open === r.id ? ' active' : ''}`} onClick={() => setOpen(r.id)}>
                <span className="pc-row pc-between"><b>{r.orgName ?? 'Компания'}</b><span className="dim">{ago(r.lastAt ?? r.waitingSince)}</span></span>
                <span className="pc-sup-sub">{r.subject || r.aiSummary || 'Без темы'}</span>
                <span className="dim pc-sup-meta">{r.userName ?? '—'} · {r.statusText}{r.agentName ? ` · ${r.agentName}` : ' · без специалиста'}{r.priority === 'high' || r.priority === 'urgent' ? ' · срочно' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="pc-sup-conv" aria-label="Разговор">
        {open ? <ConversationView key={open} id={open} onChanged={() => void load()} /> : <p className="dim">Выберите обращение слева.</p>}
      </section>
    </div>
  );
}

function ConversationView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [c, setC] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState('');
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const count = useRef(0);

  const load = useCallback(() => pc<Conversation>('GET', `/pc/support/${id}`).then((v) => { setC(v); setE(''); }).catch((x) => setE(err(x))), [id]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 5_000);
    return () => window.clearInterval(t);
  }, [load]);
  // вниз — только когда пришло новое сообщение, а не на каждом опросе
  useEffect(() => {
    const n = c?.messages.length ?? 0;
    if (n !== count.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
    count.current = n;
  }, [c]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setE('');
    try { const v = await pc<Conversation>('POST', `/pc/support/${id}/${path}`, body ?? {}); if (v && 'messages' in v) setC((p) => ({ ...v, client: p?.client ?? null, me: p?.me ?? '' })); onChanged(); }
    catch (x) { setE(err(x)); } finally { setBusy(false); }
  };
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!text.trim()) return;
    await act('reply', { text: text.trim() });
    setText('');
  };
  const loadNotes = () => pc<Note[]>('GET', `/pc/support/${id}/notes`).then(setNotes).catch((x) => setE(err(x)));
  const addNote = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!note.trim()) return;
    try { await pc('POST', `/pc/support/${id}/notes`, { text: note.trim() }); setNote(''); await loadNotes(); } catch (x) { setE(err(x)); }
  };
  const copilot = async () => {
    setHint('Думаю…');
    try { const r = await pc<{ summary: string | null; known: { title: string } | null }>('POST', `/pc/support/${id}/copilot`); setHint([r.summary, r.known ? `Похоже на известную проблему: «${r.known.title}»` : null].filter(Boolean).join('\n\n') || 'Подсказки нет'); }
    catch (x) { setHint(err(x)); }
  };
  const bug = async () => {
    const title = window.prompt('Название бага (пусто — по разговору)') ?? null;
    if (title === null) return;
    setBusy(true);
    try { await pc('POST', `/pc/support/${id}/bug`, { title: title.trim() || undefined, kind: 'bug' }); await load(); setHint('Баг заведён в проекте разработки'); }
    catch (x) { setE(err(x)); } finally { setBusy(false); }
  };
  const acceptCall = async () => {
    setBusy(true); setE('');
    try {
      const r = await pc<{ conversation: Conversation; pass: Pass }>('POST', `/pc/support/${id}/call/accept`);
      setC((p) => ({ ...r.conversation, client: p?.client ?? null, me: p?.me ?? '' }));
      openCall(r.pass);
      onChanged();
    } catch (x) { setE(err(x)); } finally { setBusy(false); }
  };
  const backToCall = async () => {
    try {
      const r = await pc<{ pass: Pass | null }>('POST', `/pc/support/${id}/call/pass`);
      if (r.pass) openCall(r.pass); else setE('Идущего созвона нет — если клиент поднял комнату сам, ссылка на неё есть в разговоре');
    } catch (x) { setE(err(x)); }
  };
  const loadGrants = () => pc<Grant[]>('GET', `/pc/support/${id}/access`).then(setGrants).catch((x) => setE(err(x)));
  const askAccess = async () => {
    const reason = window.prompt('Зачем нужен доступ к настройкам проекта клиента (на 15 минут, клиент увидит причину)?');
    if (reason === null) return;
    try { setGrants(await pc<Grant[]>('POST', `/pc/support/${id}/access`, { reason: reason.trim() || undefined })); await load(); } catch (x) { setE(err(x)); }
  };
  const viewGrant = async (g: Grant) => {
    try { setSnap(await pc<Snapshot>('GET', `/pc/support/${id}/access/${g.id}`)); } catch (x) { setE(err(x)); }
  };

  const openFile = async (m: Msg) => {
    try {
      const res = await fetch(`/api/pc/support/${id}/files/${m.fileId}`, { headers: tokenHeader() });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setE('Файл не открылся'); }
  };

  if (!c) return e ? <p className="pc-err">{e}</p> : <p className="dim">Загрузка…</p>;
  const mine = c.agentId === c.me;
  const closed = c.status === 'closed';
  const ctx = c.context;

  return (
    <div className="pc-sup-pane">
      <header className="pc-sup-head">
        <div>
          <h2 className="pc-h-flat">{c.orgName ?? 'Компания'}</h2>
          <div className="dim">{c.subject || c.aiSummary || 'Без темы'} · {c.statusText} · открыто {fmtDate(c.createdAt)}</div>
        </div>
        <div className="pc-actions">
          {!mine && !closed && <button type="button" className="pc-btn" disabled={busy} onClick={() => void act('join')}>Взять себе</button>}
          {mine && !closed && <button type="button" className="pc-btn pc-btn-ghost" disabled={busy} onClick={() => void act('unassign')}>Отдать в очередь</button>}
          {!closed && c.status !== 'resolved' && <button type="button" className="pc-btn pc-btn-ghost" disabled={busy} onClick={() => void act('resolve')}>Решено — спросить клиента</button>}
          {mine && c.aiMode === 'copilot' && !closed && <button type="button" className="pc-btn pc-btn-ghost" disabled={busy} onClick={() => void act('ai/return')}>Вернуть помощнику</button>}
        </div>
      </header>

      {c.client && (
        <div className="pc-sup-card">
          <div><span className="dim">Компания</span> {c.client.company}{c.client.isTest ? <span className="pc-tag">тестовая</span> : null} · {c.client.members} сотр.</div>
          <div><span className="dim">Тариф</span> {c.client.plan ?? 'не выбран'} — {c.client.subscription.text}{c.client.subscription.until ? ` до ${fmtDate(c.client.subscription.until)}` : ''}</div>
          <div><span className="dim">ИИ</span> <span className={c.client.ai.state === 'off' ? 'pc-down' : ''}>{c.client.ai.text}</span></div>
          {ctx && (
            <div className="dim">
              {[ctx.route && `экран ${ctx.route}`, ctx.platform === 'capacitor' ? `приложение ${ctx.native_version ?? ''}` : ctx.browser, ctx.os, ctx.device,
                ctx.app_version && `версия ${ctx.app_version}`, ctx.network && `сеть ${ctx.network}`].filter(Boolean).join(' · ')}
            </div>
          )}
          {ctx?.last_error && <div className="pc-mono pc-down">Последняя ошибка: {ctx.last_error}</div>}
        </div>
      )}
      {c.handoffNote && <p className="pc-sup-note"><b>Записка от помощника:</b> {c.handoffNote}</p>}

      <div className="pc-sup-feed" ref={feed}>
        {c.messages.map((m) => (
          <div key={m.id} className={`pc-sup-msg pc-sup-${m.kind}`}>
            {m.kind !== 'system' && <div className="pc-sup-author">{m.authorName ?? (m.kind === 'user' ? 'Клиент' : 'Служба заботы')} <span className="dim">{fmtDate(m.createdAt)}</span></div>}
            {m.body && <div className="pc-sup-body"><Linked text={m.body} /></div>}
            {m.fileId && <button type="button" className="pc-link" onClick={() => void openFile(m)}>{m.fileName ?? 'файл'}</button>}
          </div>
        ))}
      </div>

      {!closed && (
        <div className="pc-sup-call">
          {c.call && c.call.byRole === 'user' && (
            <>
              <b>Клиент просит созвон</b>
              <button type="button" className="pc-btn" disabled={busy} onClick={() => void acceptCall()}>Принять созвон</button>
              <button type="button" className="pc-btn pc-btn-ghost" disabled={busy} onClick={() => void act('call/decline')}>Сейчас неудобно</button>
            </>
          )}
          {c.call && c.call.byRole !== 'user' && <span className="dim">Созвон предложен — ждём согласия клиента. Когда он согласится, ссылка на созвон появится в разговоре.</span>}
          {!c.call && <button type="button" className="pc-btn pc-btn-ghost" disabled={busy} onClick={() => void act('call/request')}>Предложить созвон</button>}
          <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void backToCall()}>Вернуться в созвон</button>
          <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void (grants ? setGrants(null) : loadGrants())}>Доступ к настройкам</button>
        </div>
      )}
      {grants && (
        <div className="pc-card pc-gap">
          <div className="pc-row pc-between"><b>Доступ к настройкам проекта клиента</b><button type="button" className="pc-link" onClick={() => { setGrants(null); setSnap(null); }}>Скрыть</button></div>
          <p className="dim pc-meta">15 минут, только по разрешению клиента и только проект, который он сам выберет. Клиент может закрыть доступ в любой момент; каждый просмотр — в журнале.</p>
          {grants.length === 0 && <p className="dim">Доступа не просили.</p>}
          {grants.map((g) => (
            <div key={g.id} className="pc-row pc-wrap pc-between">
              <span>{g.projectName ?? 'проект не выбран'} — {GRANT_TEXT[g.status] ?? g.status}{g.expiresAt && g.status === 'granted' ? ` до ${fmtDate(g.expiresAt)}` : ''}{g.reason ? <span className="dim"> · {g.reason}</span> : null}</span>
              {g.status === 'granted' && <button type="button" className="pc-link" onClick={() => void viewGrant(g)}>Открыть</button>}
            </div>
          ))}
          <button type="button" className="pc-btn pc-gap" onClick={() => void askAccess()}>Попросить доступ</button>
          {snap?.project && (
            <div className="pc-sup-card pc-gap">
              <b>{snap.project.name}</b>
              <div className="dim">видимость: {snap.project.visibility}{snap.project.owner_name ? ` · руководитель ${snap.project.owner_name}` : ''}{snap.project.client_name ? ` · клиент ${snap.project.client_name}` : ''}</div>
              <div>Колонки: {snap.columns.map((col) => `${col.name} (${col.tasks})`).join(' → ') || '—'}</div>
              <div>Участники: {snap.members.map((mm) => mm.full_name).join(', ') || '—'}</div>
              <div className="dim">доступ до {fmtDate(snap.expiresAt)}</div>
            </div>
          )}
        </div>
      )}
      {e && <p className="pc-err">{e}</p>}
      {!closed && (
        <form className="pc-sup-reply" onSubmit={send}>
          <textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={3} maxLength={8000} placeholder="Ответ клиенту"
            onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) void send(ev); }} aria-label="Ответ клиенту" />
          <div className="pc-actions">
            <button className="pc-btn" disabled={busy || !text.trim()}>Отправить</button>
            <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void copilot()}>Подсказка</button>
            <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void (notes ? setNotes(null) : loadNotes())}>Заметки</button>
            <button type="button" className="pc-btn pc-btn-ghost" disabled={busy} onClick={() => void bug()}>Завести баг</button>
          </div>
        </form>
      )}
      {hint && <div className="pc-card pc-gap pc-sup-hint"><div className="pc-row pc-between"><b>Подсказка</b><button type="button" className="pc-link" onClick={() => setHint(null)}>Скрыть</button></div><p>{hint}</p></div>}
      {notes && (
        <div className="pc-card pc-gap">
          <b>Заметки — клиент их не видит</b>
          {notes.length === 0 && <p className="dim">Пока нет.</p>}
          {notes.map((n) => <p key={n.id}><span className="dim">{n.authorName} · {fmtDate(n.createdAt)}</span><br />{n.body}</p>)}
          <form className="pc-row" onSubmit={addNote}>
            <input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={4000} placeholder="Заметка для коллег" aria-label="Заметка" />
            <button className="pc-btn" disabled={!note.trim()}>Добавить</button>
          </form>
        </div>
      )}
    </div>
  );
}

/** Известные проблемы и массовый сбой — у руководителя службы (у первой линии сервер ответит отказом). */
function KnownAndIncident() {
  const [known, setKnown] = useState<Known[] | null>(null);
  const [inc, setInc] = useState<Incident | null | undefined>(undefined);
  const [e, setE] = useState('');
  const [form, setForm] = useState({ taskId: '', title: '', pattern: '' });
  const [incForm, setIncForm] = useState({ title: '', message: '' });
  const load = () => {
    pc<Known[]>('GET', '/pc/support/known').then(setKnown).catch((x) => setE(err(x)));
    pc<{ incident: Incident | null }>('GET', '/pc/support/incident').then((r) => setInc(r.incident)).catch(() => setInc(null));
  };
  useEffect(load, []);

  const addKnown = async (ev: FormEvent) => {
    ev.preventDefault(); setE('');
    try { await pc('POST', '/pc/support/known', { taskId: form.taskId, title: form.title, pattern: form.pattern || undefined }); setForm({ taskId: '', title: '', pattern: '' }); load(); }
    catch (x) { setE(err(x)); }
  };
  const toggle = async (k: Known) => { try { setKnown(await pc<Known[]>('POST', `/pc/support/known/${k.id}`, { active: !k.active })); } catch (x) { setE(err(x)); } };
  const declare = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!window.confirm('Объявить сбой? Сообщение уйдёт во все открытые разговоры всех компаний.')) return;
    try { await pc('POST', '/pc/support/incident', incForm); setIncForm({ title: '', message: '' }); load(); } catch (x) { setE(err(x)); }
  };
  const resolve = async () => {
    if (!inc || !window.confirm('Сбой исправлен? Всем, кому говорили о нём, уйдёт «Исправлено».')) return;
    try { await pc('POST', `/pc/support/incident/${inc.id}/resolve`); load(); } catch (x) { setE(err(x)); }
  };

  return (
    <section>
      {e && <p className="pc-err">{e}</p>}
      <h3>Массовый сбой</h3>
      {inc ? (
        <div className="pc-card pc-sup-note">
          <b>Идёт сбой: {inc.title}</b> <span className="dim">с {fmtDate(inc.started_at)}</span>
          <p>{inc.message}</p>
          <button type="button" className="pc-btn" onClick={() => void resolve()}>Исправлено — сообщить всем</button>
        </div>
      ) : (
        <form className="pc-card pc-form" onSubmit={declare}>
          <p className="dim pc-meta">Одно честное сообщение вместо двадцати одинаковых разговоров: уйдёт во все открытые обращения, панель поддержки покажет полосу.</p>
          <label>Что сломалось<input value={incForm.title} onChange={(ev) => setIncForm({ ...incForm, title: ev.target.value })} maxLength={200} required /></label>
          <label>Что сказать клиентам<textarea value={incForm.message} onChange={(ev) => setIncForm({ ...incForm, message: ev.target.value })} maxLength={1000} rows={2} required /></label>
          <button className="pc-btn">Объявить сбой</button>
        </form>
      )}

      <h3>Известные проблемы</h3>
      <p className="dim pc-meta">Задача в проекте разработки + слова-приметы: обращение с такими словами помощник сразу узнаёт и честно говорит, что исправление готовится.</p>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Задача</th><th>Проблема</th><th>Приметы</th><th>Состояние</th><th /></tr></thead>
          <tbody>
            {known?.length === 0 && <tr><td colSpan={5} className="dim">Пока нет.</td></tr>}
            {known?.map((k) => (
              <tr key={k.id} className={k.active && !k.fixed ? '' : 'dim'}>
                <td>#{k.taskId}</td><td>{k.title}</td><td className="pc-mono">{k.pattern}</td>
                <td>{k.fixed ? 'исправлено' : k.active ? 'узнаём' : 'выключено'}</td>
                <td>{!k.fixed && <button type="button" className="pc-link" onClick={() => void toggle(k)}>{k.active ? 'Выключить' : 'Включить'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="pc-row pc-wrap pc-gap" onSubmit={addKnown}>
        <label>Номер задачи<input value={form.taskId} onChange={(ev) => setForm({ ...form, taskId: ev.target.value })} maxLength={20} required /></label>
        <label>Проблема<input value={form.title} onChange={(ev) => setForm({ ...form, title: ev.target.value })} maxLength={200} required /></label>
        <label>Приметы через запятую<input value={form.pattern} onChange={(ev) => setForm({ ...form, pattern: ev.target.value })} maxLength={300} /></label>
        <button className="pc-btn">Добавить</button>
      </form>
    </section>
  );
}

function Stats({ avail }: { avail: Availability | null }) {
  const [d, setD] = useState<Dashboard | null>(null);
  const [e, setE] = useState('');
  useEffect(() => { pc<Dashboard>('GET', '/pc/support/dashboard').then(setD).catch((x) => setE(err(x))); }, []);
  if (e) return <p className="pc-err">{e}</p>;
  if (!d) return <p className="dim">Загрузка…</p>;
  const s = d.summary;
  const k = (label: string, value: string, sub?: string) => (
    <div className="pc-kpi"><div className="pc-kpi-label">{label}</div><div className="pc-kpi-value">{value}</div>{sub && <div className="pc-kpi-delta dim">{sub}</div>}</div>
  );
  return (
    <section>
      <p className="dim pc-meta">Время — медианы по фактическим ответам людей, без обещаний «за 30 секунд» (§6).</p>
      <div className="pc-kpis">
        {k('Открыто сейчас', String(s.active), `ждут специалиста: ${s.waiting}`)}
        {k('Первый ответ человека', dur(s.firstResponseSeconds))}
        {k('Ожидание в очереди', dur(s.queueWaitSeconds))}
        {k('До решения', dur(s.resolutionSeconds))}
        {k('Оценка клиентов', s.csatAvg == null ? '—' : `${s.csatAvg} из 4`, `оценок: ${s.csatCount}`)}
        {k('Решил помощник сам', String(s.solvedByAi), `передал людям: ${s.escalated}`)}
        {k('Открыли повторно', String(s.reopened))}
        {k('Всего обращений', String(s.total), `решено: ${s.resolved}`)}
      </div>
      {avail && (
        <>
          <h3>Специалисты</h3>
          <div className="pc-table-wrap">
            <table className="pc-table">
              <thead><tr><th>Имя</th><th>Статус</th></tr></thead>
              <tbody>{avail.engineers.map((p) => <tr key={p.userId}><td>{p.name}</td><td>{p.statusText}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
