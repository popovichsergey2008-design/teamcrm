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
  context: { route?: string | null; app_version?: string | null; browser?: string | null; os?: string | null; platform?: string | null;
    native_version?: string | null; device?: string | null; last_error?: string | null; network?: string | null } | null;
}
interface Note { id: string; authorName: string | null; body: string; createdAt: string }
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
  const [tab, setTab] = useState<'queue' | 'stats'>('queue');
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
      {tab === 'queue' ? <Queue /> : <Stats avail={avail} />}
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
            {m.body && <div className="pc-sup-body">{m.body}</div>}
            {m.fileId && <button type="button" className="pc-link" onClick={() => void openFile(m)}>{m.fileName ?? 'файл'}</button>}
          </div>
        ))}
      </div>

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
