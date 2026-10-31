import { useEffect, useState } from 'react';
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

export default function DevConsole() {
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
      <p className="dim pc-meta">Сбор ошибок сайта и сервера с группировкой и поиском по request_id — следующий этап.</p>
    </section>
  );
}
