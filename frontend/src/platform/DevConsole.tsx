import { FormEvent, useEffect, useState } from 'react';
import { fmtDate, pc, PcError } from './api';

interface Status {
  env: string;
  health: { status: string; checks: Record<string, string>; schemaVersion: string | null };
  build: { sha: string | null; at: string | null; run: string | null; startedAt: string; color: string | null };
  queues: { queue: string; status: string; n: number; oldest_min: number | null; last_error: string | null }[];
  crashes: { version: string; message: string; n: number; users: number; last_at: string }[];
  storage: { dbBytes: number; filesBytes: number; files: number } | null;
  generatedAt: string;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(2)} ГБ`;
const STUCK = new Set(['pending', 'running', 'failed', 'error']);

export default function DevConsole({ canTriage }: { canTriage: boolean }) {
  const [tab, setTab] = useState<'status' | 'errors'>('status');
  return (
    <>
      <nav className="pc-tabs" aria-label="Разделы">
        <button type="button" className="pc-tab" aria-pressed={tab === 'status'} onClick={() => setTab('status')}>Состояние</button>
        <button type="button" className="pc-tab" aria-pressed={tab === 'errors'} onClick={() => setTab('errors')}>Ошибки</button>
      </nav>
      {tab === 'status' ? <StatusTab /> : <ErrorsTab canTriage={canTriage} />}
    </>
  );
}

function StatusTab() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const load = () => pc<Status>('GET', '/pc/dev/status').then((v) => { setS(v); setErr(''); }).catch((e) => setErr(e instanceof PcError ? e.message : 'Не загрузилось'));
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => window.clearInterval(t);
  }, []);

  if (err) return <p className="pc-err">{err}</p>;
  if (!s) return <p className="dim">Загрузка…</p>;
  return (
    <section>
      <p className="dim pc-meta">Среда: <b>{s.env}</b>. Обновляется раз в 30 секунд, последний раз {fmtDate(s.generatedAt)}.</p>
      <div className="pc-kpis">
        <div className="pc-kpi"><div className="pc-kpi-label">Состояние</div><div className={`pc-kpi-value ${s.health.status === 'ok' ? 'pc-up' : 'pc-down'}`}>{s.health.status === 'ok' ? 'всё работает' : 'есть сбой'}</div>
          <div className="pc-kpi-delta dim">{Object.entries(s.health.checks).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div></div>
        <div className="pc-kpi"><div className="pc-kpi-label">Сборка</div><div className="pc-kpi-value">{s.build.sha ? s.build.sha.slice(0, 7) : 'нет данных'}</div>
          <div className="pc-kpi-delta dim">{s.build.at ? `коммит ${fmtDate(s.build.at)}` : ''}{s.build.run ? ` · прогон CI №${s.build.run}` : ''}</div></div>
        <div className="pc-kpi"><div className="pc-kpi-label">Процесс API запущен</div><div className="pc-kpi-value">{fmtDate(s.build.startedAt)}</div>
          <div className="pc-kpi-delta dim">схема базы: {s.health.schemaVersion ?? '—'}</div></div>
        {s.storage && <div className="pc-kpi"><div className="pc-kpi-label">Хранилище</div><div className="pc-kpi-value">{gb(s.storage.dbBytes)}</div>
          <div className="pc-kpi-delta dim">база · файлы {gb(s.storage.filesBytes)} ({s.storage.files})</div></div>}
      </div>

      <h3>Фоновые очереди</h3>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Очередь</th><th>Статус</th><th>Штук</th><th>Самому старому</th><th>Последняя ошибка</th></tr></thead>
          <tbody>
            {s.queues.length === 0 && <tr><td colSpan={5} className="dim">Пусто — заданий за последние сутки нет.</td></tr>}
            {s.queues.map((q) => (
              <tr key={`${q.queue}-${q.status}`} className={STUCK.has(q.status) && (q.oldest_min ?? 0) > 30 ? 'pc-warn-row' : ''}>
                <td>{q.queue}</td><td>{q.status}</td><td>{q.n}</td>
                <td>{q.oldest_min == null ? '—' : q.oldest_min < 60 ? `${q.oldest_min} мин` : `${Math.round(q.oldest_min / 60)} ч`}</td>
                <td className="pc-mono">{q.last_error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Падения приложения за 7 дней</h3>
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead><tr><th>Версия</th><th>Ошибка</th><th>Раз</th><th>Людей</th><th>Последний раз</th></tr></thead>
          <tbody>
            {s.crashes.length === 0 && <tr><td colSpan={5} className="dim">Падений не было.</td></tr>}
            {s.crashes.map((c, i) => (
              <tr key={i}><td>{c.version}</td><td className="pc-mono">{c.message}</td><td>{c.n}</td><td>{c.users}</td><td>{fmtDate(c.last_at)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface ErrRow {
  id: string; source: string; kind: string; message: string; route: string | null; first_seen: string; last_seen: string;
  first_version: string | null; last_version: string | null; hits: string; status: string; fixed_version: string | null;
  note: string | null; hits_24h: number; clients_7d: number;
}
interface ErrOne extends ErrRow {
  stack: string | null;
  events: { at: string; request_id: string | null; version: string | null; route: string | null; tenant_id: string | null }[];
  byVersion: { version: string | null; n: number }[];
}
const SRC: Record<string, string> = { server: 'сервер', web: 'сайт', mobile: 'приложение' };
const ST: Record<string, string> = { new: 'новая', fixed: 'исправлена', ignored: 'не важно' };

function ErrorsTab({ canTriage }: { canTriage: boolean }) {
  const [status, setStatus] = useState('new');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ErrRow[] | null>(null);
  const [open, setOpen] = useState<ErrOne | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    const p = new URLSearchParams({ ...(status ? { status } : {}), ...(source ? { source } : {}), ...(query ? { q: query } : {}) });
    pc<ErrRow[]>('GET', `/pc/dev/errors?${p}`).then((v) => { setRows(v); setErr(''); }).catch((e) => setErr(e instanceof PcError ? e.message : 'Не загрузилось'));
  };
  useEffect(load, [status, source, query]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (id: string) => pc<ErrOne>('GET', `/pc/dev/errors/${id}`).then(setOpen).catch(() => undefined);
  const mark = async (id: string, st: string) => {
    const version = st === 'fixed' ? (window.prompt('В какой сборке исправлено? (можно пусто)') ?? '') : '';
    try { await pc('POST', `/pc/dev/errors/${id}`, { status: st, version: version || undefined }); load(); if (open?.id === id) void show(id); }
    catch (e) { alert(e instanceof PcError ? e.message : 'Не получилось'); }
  };
  const search = (e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); };

  return (
    <section>
      <div className="pc-row pc-wrap">
        <div className="pc-seg" role="group" aria-label="Статус">
          {[['new', 'Новые'], ['fixed', 'Исправленные'], ['ignored', 'Не важные'], ['', 'Все']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>
          ))}
        </div>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Источник">
          <option value="">Все источники</option><option value="server">Сервер</option><option value="web">Сайт</option><option value="mobile">Приложение</option>
        </select>
        <form onSubmit={search} className="pc-row">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Текст ошибки или request_id" aria-label="Поиск" />
          <button className="pc-btn pc-btn-ghost">Найти</button>
        </form>
      </div>
      {err && <p className="pc-err">{err}</p>}
      <div className="pc-table-wrap pc-gap">
        <table className="pc-table">
          <thead><tr><th>Ошибка</th><th>Где</th><th>Раз всего / за сутки</th><th>Затронуто за 7 дн.</th><th>Версии</th><th>Последний раз</th><th>Статус</th></tr></thead>
          <tbody>
            {rows?.length === 0 && <tr><td colSpan={7} className="dim">Ничего нет.</td></tr>}
            {rows?.map((r) => (
              <tr key={r.id}>
                <td><button type="button" className="pc-link" onClick={() => void show(r.id)}><b>{r.kind}</b></button><div className="pc-mono">{r.message}</div></td>
                <td>{SRC[r.source] ?? r.source}<div className="dim pc-mono">{r.route ?? ''}</div></td>
                <td>{r.hits} / {r.hits_24h}</td>
                <td>{r.clients_7d}</td>
                <td className="pc-mono">{r.first_version ?? '—'}{r.last_version && r.last_version !== r.first_version ? ` → ${r.last_version}` : ''}</td>
                <td>{fmtDate(r.last_seen)}</td>
                <td>{ST[r.status] ?? r.status}{r.fixed_version ? ` в ${r.fixed_version}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="pc-card pc-gap">
          <div className="pc-row pc-between">
            <h3 className="pc-h-flat">{open.kind}: <span className="pc-mono">{open.message}</span></h3>
            <button type="button" className="pc-btn pc-btn-ghost" onClick={() => setOpen(null)}>Закрыть</button>
          </div>
          <p className="dim pc-meta">Впервые {fmtDate(open.first_seen)} ({open.first_version ?? 'версия неизвестна'}), последний раз {fmtDate(open.last_seen)}. Всего {open.hits}.</p>
          {canTriage && (
            <div className="pc-actions">
              {open.status !== 'fixed' && <button type="button" className="pc-btn" onClick={() => void mark(open.id, 'fixed')}>Исправлено</button>}
              {open.status !== 'ignored' && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void mark(open.id, 'ignored')}>Не важно</button>}
              {open.status !== 'new' && <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void mark(open.id, 'new')}>Вернуть в новые</button>}
            </div>
          )}
          <p className="dim pc-meta">Исправленная ошибка, появившись снова, сама возвращается в «Новые».</p>
          {open.stack && <pre className="pc-mono pc-stack">{open.stack}</pre>}
          <h3>По версиям</h3>
          <p className="pc-mono">{open.byVersion.map((v) => `${v.version ?? '—'}: ${v.n}`).join(' · ') || '—'}</p>
          <h3>Последние случаи</h3>
          <div className="pc-table-wrap">
            <table className="pc-table">
              <thead><tr><th>Когда</th><th>request_id</th><th>Версия</th><th>Путь</th><th>Компания</th></tr></thead>
              <tbody>{open.events.map((e, i) => (
                <tr key={i}><td>{fmtDate(e.at)}</td><td className="pc-mono">{e.request_id ?? '—'}</td><td className="pc-mono">{e.version ?? '—'}</td><td className="pc-mono">{e.route ?? ''}</td><td>{e.tenant_id ?? '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
